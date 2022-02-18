export const LOG_LEVEL = {
    VERBOSE: 1,
    INFO: 10,
    NOTICE: 100,
    URGENT: 1000,
} as const;
export type LOG_LEVEL = typeof LOG_LEVEL[keyof typeof LOG_LEVEL];

export type type_direction = "-->" | "<--";

export interface config {
    uri: string;
    auth: {
        username: string;
        password: string;
        passphrase: string;
    };
    path: string;
}

export interface eachConf {
    private: config;
    shared: config;
}

export interface configFile {
    [key: string]: eachConf;
}
