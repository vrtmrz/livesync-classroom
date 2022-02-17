import { decrypt, encrypt } from "./e2ee.js";
//@ts-ignore
import { PouchDB as PouchDB_src } from "./pouchdb.js";
import * as fs from "fs";
import { Logger } from "./logger.js";
import { LOG_LEVEL } from "./types.js";
const xxhash = require("xxhash-wasm");
const PouchDB: PouchDB.Static<{}> = PouchDB_src;

function log(log: any) {
    Logger(log, LOG_LEVEL.INFO);
}

let h32Raw: (inputBuffer: Uint8Array, seed?: number | undefined) => number;
let h32: (input: string, seed?: number) => string;
let known_files: string[] = [];
type type_direction = "-->" | "<--";

function addKnownFile(direction: type_direction, id: string, rev: string) {
    known_files.push(`${direction}-${id}-${rev}`);
    known_files = known_files.slice(-50);
}
function isKnownFile(direction: type_direction, id: string, rev: string) {
    return known_files.indexOf(`${direction}-${id}-${rev}`) !== -1;
}
const statFile = "./dat/stat.json";
let syncStat = { main_to_shared: "now", shared_to_main: "now" };
let saveStatTimer: NodeJS.Timeout | undefined = undefined;
let saveStatCount: 0;
function saveStat() {
    fs.writeFileSync(statFile, JSON.stringify(syncStat));
}
function triggerSaveStat() {
    if (saveStatTimer == undefined) clearTimeout(saveStatTimer);
    if (saveStatCount > 25) {
        saveStatTimer = undefined;
        saveStatCount = 0;
        saveStat();
    } else {
        saveStatCount++;
        saveStatTimer = setTimeout(() => {
            saveStat();
        }, 500);
    }
}
interface config {
    uri: string;
    auth: {
        username: string;
        password: string;
        passphrase: string;
    };
    path: string;
}
interface configFile {
    private: config;
    shared: config;
}

async function main() {
    let xx = await xxhash();
    let config: configFile = JSON.parse(fs.readFileSync("./dat/config.json") + "");

    const mainDB = config.private.uri;
    const mainAuth = config.private.auth;
    const mainPath = config.private.path;

    const sharedDB = config.shared.uri;
    const sharedAuth = config.shared.auth;
    const sharedPath = config.shared.path;

    const main_remote = new PouchDB(mainDB, { auth: mainAuth });
    const shared_remote = new PouchDB(sharedDB, { auth: sharedAuth });

    async function sanityCheck() {
        let mr = await main_remote.info();
        log("Main Remote Database");
        log(mr);

        let sr = await shared_remote.info();
        log("Shared Remote Database");
        log(sr);
    }
    try {
        var st = JSON.parse(fs.readFileSync(statFile) + "");
        syncStat.main_to_shared == st.main_to_shared ?? "now";
        syncStat.shared_to_main == st.shared_to_main ?? "now";
    } catch (ex) {
        log("could not read pervious sync status, initialized.");
    }
    h32Raw = xx.h32Raw;
    h32 = xx.h32ToString;
    log("LiveSync-classroom starting up.");
    try {
        await sanityCheck();
    } catch (ex) {
        log("Error on checking database");
        log(ex);
    }
    log("Start main watching");
    main_remote
        .changes({
            live: true,
            include_docs: true,
            style: "all_docs",
            since: syncStat.main_to_shared,
            filter: (doc, params) => {
                if (doc._id.startsWith(mainPath) && isVaildDoc(doc._id)) {
                    return true;
                }
                return false;
            },
        })
        .on("change", async function (change) {
            if (change.doc?._id.startsWith(mainPath) && isVaildDoc(change.doc._id)) {
                let x = await transferDoc("-->", main_remote, change.doc, mainPath, shared_remote, sharedPath, mainAuth.passphrase, sharedAuth.passphrase);
                if (x) {
                    syncStat.main_to_shared = change.seq + "";
                    triggerSaveStat();
                }
            }
        })
        .on("error", function (err) {
            log("error");
            log(err);
            process.exit(-1);
        });
    shared_remote
        .changes({
            live: true,
            include_docs: true,
            style: "all_docs",
            since: syncStat.shared_to_main,
            filter: (doc, params) => {
                if (doc._id.startsWith(sharedPath) && isVaildDoc(doc._id)) {
                    return true;
                }
                return false;
            },
        })
        .on("change", async function (change) {
            if (change.doc?._id.startsWith(sharedPath) && isVaildDoc(change.doc._id)) {
                let x = await transferDoc("<--", shared_remote, change.doc, sharedPath, main_remote, mainPath, sharedAuth.passphrase, mainAuth.passphrase);
                if (x) {
                    syncStat.shared_to_main = change.seq + "";
                    triggerSaveStat();
                }
            }
        })
        .on("error", function (err) {
            log("error");
            log(err);
            process.exit(-1);
        });
}

function delay(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(() => res(), ms));
}
async function getChildren(children: string[], db: PouchDB.Database) {
    let items = await db.allDocs({ include_docs: true, keys: [...children] });
    let entries = items.rows.map((e) => e.doc);
    return entries;
}
function normalizeDocForDiff(doc: any): string {
    const r = JSON.stringify({
        mtime: doc.mtime ?? "",
        chilldren: doc.children ?? [],
        _deleted: doc._deleted,
    });
    return r;
}
function isVaildDoc(id: string): boolean {
    if (id == "obsydian_livesync_version") return false;
    if (id.indexOf(":") !== -1) return false;
    return true;
}
function getCounterSide(direction: type_direction): type_direction {
    if (direction == "-->") return "<--";
    return "-->";
}
let running = false;
async function transferDoc(
    direction: type_direction,
    fromDB: PouchDB.Database,
    fromDoc: PouchDB.Core.ExistingDocument<PouchDB.Core.ChangesMeta>,
    fromPrefix: string,
    toDB: PouchDB.Database,
    toPrefix: string,
    decryptKey: string,
    encryptKey: string
): Promise<boolean> {
    const docKey = `${direction} ${fromDoc._id} (${fromDoc._rev})`;
    while (running) {
        await delay(100);
    }
    try {
        running = true;
        if (isKnownFile(direction, fromDoc._id, fromDoc._rev)) {
            return true;
        }
        log(`doc:${docKey} begin Transfer`);
        let continue_count = 10;
        try {
            let transferDoc: PouchDB.Core.ExistingDocument<PouchDB.Core.ChangesMeta> & { children?: string[] } = { ...fromDoc, _id: toPrefix + fromDoc._id.substring(fromPrefix.length) };
            let retry = false;
            const userpasswordHash = h32Raw(new TextEncoder().encode(encryptKey));
            do {
                if (retry) {
                    continue_count--;
                    if (continue_count == 0) {
                        log(`doc:${docKey} retry count exeeedec`);
                        return false;
                    }
                    await delay(1500);
                }
                retry = false;
                let oldRemoteDoc: any;
                try {
                    oldRemoteDoc = (await toDB.get(transferDoc._id)) as any;
                    transferDoc._rev = oldRemoteDoc._rev;
                } catch (ex: any) {
                    if (ex.status && ex.status == 404) {
                        if (transferDoc._deleted) {
                            // we have to skip this.
                            log(`doc:${docKey} it had been deleted, and there's no need to synchronized`);
                            return true;
                        }
                        // If new doc. we doesn't need _rev;
                        delete (transferDoc as any)._rev;
                    } else {
                        throw ex;
                    }
                }

                if (!transferDoc.children) {
                    log(`doc:${docKey}: Warning! document doesn't have chunks, skipped`);
                    return false;
                }
                let cx = transferDoc.children;
                let children = await getChildren(cx, fromDB);

                if (children.includes(undefined)) {
                    log(`doc:${docKey}: Warning! there's missing chunks, skipped`);
                    return false;
                } else {
                    children = children.filter((e) => !!e);
                    for (const v of children) {
                        delete (v as any)?._rev;
                    }

                    let decrypted_children =
                        decryptKey == ""
                            ? children
                            : (
                                  await Promise.allSettled(
                                      children.map(async (e: any) => {
                                          e.data = await decrypt(e.data, decryptKey);
                                          return e;
                                      })
                                  )
                              ).map((e) => (e.status == "fulfilled" ? e.value : null));
                    let encrypted_children = (
                        await Promise.allSettled(
                            decrypted_children.map(async (e: any) => {
                                // justify ids.
                                if (encryptKey == "") {
                                    e._id = "h:" + h32(e.data);
                                } else {
                                    e._id = "h:+" + (h32Raw(new TextEncoder().encode(e.data)) ^ userpasswordHash).toString(16);
                                    e.data = await encrypt(e.data, encryptKey);
                                }
                                return e;
                            })
                        )
                    ).map((e) => (e.status == "fulfilled" ? e.value : null));
                    if (encrypted_children.includes(null)) {
                        log(`doc:${docKey}: Warning! could not encrypt and decrypt doc, skipped`);
                        retry = true;
                        continue;
                    }
                    transferDoc.children = encrypted_children.map((e) => e._id);
                    let diffDoc = encrypted_children.filter((e) => oldRemoteDoc.children.indexOf(e._id) === -1);
                    log(`doc:${docKey}:Transfering ${diffDoc.length} chunk(s)`);
                    let stat = await toDB.bulkDocs([...(diffDoc as PouchDB.Core.ExistingDocument<PouchDB.Core.AllDocsMeta>[])]);

                    if (stat.find((e) => (e as any).status && (e as any).status != 409)) {
                        log(stat);
                        log(`doc:${docKey}:Warning! Could not transfer leaves to server, skipped`);
                        retry = false;
                        return false;
                    }

                    try {
                        if (normalizeDocForDiff(oldRemoteDoc) == normalizeDocForDiff(transferDoc)) {
                            log(`doc:${docKey}: synchronized`);
                            retry = false;
                            return true;
                        }
                        transferDoc._rev = oldRemoteDoc._rev;
                    } catch (ex: any) {
                        if (ex.status && ex.status == 404) {
                            if (transferDoc._deleted) {
                                // we have to skip this.
                                log(`doc:${docKey} it had been deleted, and there's no need to synchronized`);
                                return true;
                            }
                            // If new doc. we doesn't need _rev;
                            delete (transferDoc as any)._rev;
                        } else {
                            throw ex;
                        }
                    }
                    try {
                        let e = await toDB.put(transferDoc);
                        if (e.ok) {
                            log(`doc:${docKey} transfered`);
                            addKnownFile(getCounterSide(direction), e.id, e.rev);
                            return true;
                        } else {
                            log(`doc:${docKey} failed to transfer`);
                        }
                    } catch (ex: any) {
                        if (ex.status && ex.status == 409) {
                            // conflicted, retry
                            log(`doc:${docKey}: Conflicted. Retry!`);
                            retry = true;
                            continue;
                        } else {
                            throw ex;
                        }
                    }
                }
            } while (retry);
        } catch (ex) {
            log("Exception on transfer doc");
            log(ex);
        }
    } finally {
        running = false;
    }
    return false;
}

main().then((_) => {});
