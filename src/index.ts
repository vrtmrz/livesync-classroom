import { decrypt, encrypt } from "./e2ee.js";
//@ts-ignore
import { PouchDB as PouchDB_src } from "./pouchdb.js";
import * as fs from "fs";
import { Logger } from "./logger.js";
import { configFile, eachConf, LOG_LEVEL, type_direction } from "./types.js";

const xxhash = require("xxhash-wasm");
const PouchDB: PouchDB.Static<{}> = PouchDB_src;

const statFile = "./dat/stat.json";
const direction_to_disp: { [key: string]: string } = {
    "-->": "private-->shared",
    "<--": "shared-->private",
};

let running: { [key: string]: boolean } = {};

let h32Raw: (inputBuffer: Uint8Array, seed?: number | undefined) => number;
let h32: (input: string, seed?: number) => string;
let known_files: string[] = [];
let syncStat: { [key: string]: { private_to_shared: string; shared_to_private: string } };
let saveStatTimer: NodeJS.Timeout | undefined = undefined;
let saveStatCount: 0;

function addKnownFile(syncKey: string, direction: type_direction, id: string, rev: string) {
    known_files.push(`${syncKey}-${direction}-${id}-${rev}`);
    known_files = known_files.slice(-50);
}
function isKnownFile(syncKey: string, direction: type_direction, id: string, rev: string) {
    return known_files.indexOf(`${syncKey}-${direction}-${id}-${rev}`) !== -1;
}

function log(log: any) {
    Logger(log, LOG_LEVEL.INFO);
}

function delay(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(() => res(), ms));
}

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
interface directionAndType {
    syncKey: string;
    direction_on_stat: "private_to_shared" | "shared_to_private";
    direction: type_direction;
    fromDB: PouchDB.Database;
    fromPrefix: string;
    toDB: PouchDB.Database;
    toPrefix: string;
    decryptKey: string;
    encryptKey: string;
}

async function main() {
    log("LiveSync-classroom starting up.");
    let xx = await xxhash();
    h32Raw = xx.h32Raw;
    h32 = xx.h32ToString;
    let config: configFile = JSON.parse(fs.readFileSync("./dat/config.json") + "");
    //let procs = [];
    try {
        syncStat = JSON.parse(fs.readFileSync(statFile) + "");
    } catch (ex) {
        log("could not read pervious sync status, initialized.");
        syncStat = {};
    }
    let procs = Object.entries(config).map((e) => eachProc(e[0], e[1]));
    await Promise.allSettled(procs);
}
async function eachProc(syncKey: string, config: eachConf) {
    log(`${syncKey} started`);

    const privateDB = config.private.uri;
    const privateAuth = config.private.auth;
    const privatePath = config.private.path;

    const sharedDB = config.shared.uri;
    const sharedAuth = config.shared.auth;
    const sharedPath = config.shared.path;

    const private_remote = new PouchDB(privateDB, { auth: privateAuth });
    const shared_remote = new PouchDB(sharedDB, { auth: sharedAuth });

    async function sanityCheck() {
        let mr = await private_remote.info();
        log("Main Remote Database");
        log(mr);

        let sr = await shared_remote.info();
        log("Shared Remote Database");
        log(sr);
    }

    if (!(syncKey in syncStat)) {
        syncStat[syncKey] = {
            private_to_shared: "now",
            shared_to_private: "now",
        };
    }

    try {
        await sanityCheck();
    } catch (ex) {
        log("Error on checking database");
        log(ex);
        process.exit(-1);
    }
    log("Start watching");

    let pairs: directionAndType[] = [
        {
            syncKey: syncKey,
            direction_on_stat: "private_to_shared",
            direction: "-->",
            fromDB: private_remote,
            fromPrefix: privatePath,
            toDB: shared_remote,
            toPrefix: sharedPath,
            decryptKey: privateAuth.passphrase,
            encryptKey: sharedAuth.passphrase,
        },
        {
            syncKey: syncKey,
            direction_on_stat: "shared_to_private",
            direction: "<--",
            toDB: private_remote,
            toPrefix: privatePath,
            fromDB: shared_remote,
            fromPrefix: sharedPath,
            encryptKey: privateAuth.passphrase,
            decryptKey: sharedAuth.passphrase,
        },
    ];
    try {
        let results = await Promise.allSettled(
            pairs.map(
                (e) =>
                    new Promise((res, rej) => {
                        e.fromDB
                            .changes({
                                live: true,
                                include_docs: true,
                                style: "all_docs",
                                since: syncStat[syncKey][e.direction_on_stat],
                                filter: (doc, _) => {
                                    return doc._id.startsWith(e.fromPrefix) && isVaildDoc(doc._id);
                                },
                            })
                            .on("change", async function (change) {
                                if (change.doc?._id.startsWith(e.fromPrefix) && isVaildDoc(change.doc._id)) {
                                    let x = await transferDoc(e.syncKey, e.direction, e.fromDB, change.doc, e.fromPrefix, e.toDB, e.toPrefix, e.decryptKey, e.encryptKey);
                                    if (x) {
                                        syncStat[syncKey][e.direction_on_stat] = change.seq + "";
                                        triggerSaveStat();
                                    }
                                }
                            })
                            .on("error", function (err) {
                                rej(err);
                            })
                            .on("complete", (result) => {
                                res(result);
                            });
                    })
            )
        );
        console.dir(results);
    } catch (ex) {
        log("error");
        log(ex);
    }
}

async function getChildren(children: string[], db: PouchDB.Database) {
    let items = await db.allDocs({ include_docs: true, keys: [...children] });
    return items.rows.map((e) => e.doc);
}
function normalizeDocForDiff(doc: any): string {
    return JSON.stringify({
        mtime: doc.mtime ?? "",
        children: doc.children ?? [],
        _deleted: doc._deleted,
    });
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

async function transferDoc(
    syncKey: string,
    direction: type_direction,
    fromDB: PouchDB.Database,
    fromDoc: PouchDB.Core.ExistingDocument<PouchDB.Core.ChangesMeta>,
    fromPrefix: string,
    toDB: PouchDB.Database,
    toPrefix: string,
    decryptKey: string,
    encryptKey: string
): Promise<boolean> {
    const docKey = `${syncKey}:${direction_to_disp[direction]} ${fromDoc._id} (${fromDoc._rev})`;
    while (running[syncKey]) {
        await delay(100);
    }
    try {
        running[syncKey] = true;
        if (isKnownFile(syncKey, direction, fromDoc._id, fromDoc._rev)) {
            return true;
        }
        log(`doc:${docKey} begin Transfer`);
        let continue_count = 3;
        try {
            let sendDoc: PouchDB.Core.ExistingDocument<PouchDB.Core.ChangesMeta> & { children?: string[] } = { ...fromDoc, _id: toPrefix + fromDoc._id.substring(fromPrefix.length) };
            let retry = false;
            const userpasswordHash = h32Raw(new TextEncoder().encode(encryptKey));
            do {
                if (retry) {
                    continue_count--;
                    if (continue_count == 0) {
                        log(`doc:${docKey} retry failed`);
                        return false;
                    }
                    await delay(1500);
                }
                retry = false;
                let oldRemoteDoc: any = { children: [] };
                try {
                    oldRemoteDoc = (await toDB.get(sendDoc._id)) as any;
                    sendDoc._rev = oldRemoteDoc._rev;
                } catch (ex: any) {
                    if (ex.status && ex.status == 404) {
                        if (sendDoc._deleted) {
                            // we have to skip this.
                            log(`doc:${docKey} it had been deleted, and there's no need to synchronized`);
                            return true;
                        }
                        // If new doc. we don't need _rev;
                        delete (sendDoc as any)._rev;
                    } else {
                        throw ex;
                    }
                }

                if (!sendDoc.children) {
                    log(`doc:${docKey}: Warning! document doesn't have chunks, skipped`);
                    return false;
                }
                let cx = sendDoc.children;
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
                    sendDoc.children = encrypted_children.map((e) => e._id);
                    let diffDoc = encrypted_children.filter((e) => oldRemoteDoc.children.indexOf(e._id) === -1);
                    log(`doc:${docKey}:Transferring ${diffDoc.length} chunk(s)`);
                    let stat = await toDB.bulkDocs([...(diffDoc as PouchDB.Core.ExistingDocument<PouchDB.Core.AllDocsMeta>[])]);

                    if (stat.find((e) => (e as any).status && (e as any).status != 409)) {
                        log(stat);
                        log(`doc:${docKey}:Warning! Could not transfer leaves to server, skipped`);
                        retry = false;
                        return false;
                    }

                    try {
                        if (normalizeDocForDiff(oldRemoteDoc) == normalizeDocForDiff(sendDoc)) {
                            log(`doc:${docKey}: synchronized`);
                            retry = false;
                            return true;
                        }
                        sendDoc._rev = oldRemoteDoc._rev;
                    } catch (ex: any) {
                        if (ex.status && ex.status == 404) {
                            if (sendDoc._deleted) {
                                // we have to skip this.
                                log(`doc:${docKey} it had been deleted, and there's no need to synchronized`);
                                return true;
                            }
                            // If new doc. we don't need _rev;
                            delete (sendDoc as any)._rev;
                        } else {
                            throw ex;
                        }
                    }
                    try {
                        let e = await toDB.put(sendDoc);
                        if (e.ok) {
                            log(`doc:${docKey} transferred`);
                            addKnownFile(syncKey, getCounterSide(direction), e.id, e.rev);
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
        running[syncKey] = false;
    }
    return false;
}

main().then((_) => {});
