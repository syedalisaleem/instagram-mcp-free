import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOME_DIR_NAME, HOME_ENV, PAIRINGS_FILE_NAME } from './constants.js';
export class PairingStore {
    path;
    dir;
    data;
    constructor() {
        this.dir = process.env[HOME_ENV] || join(homedir(), HOME_DIR_NAME);
        this.path = join(this.dir, PAIRINGS_FILE_NAME);
        this.data = this.read();
    }
    get serverId() {
        return this.data.serverId;
    }
    get filePath() {
        return this.path;
    }
    getToken(instanceId) {
        if (!instanceId)
            return null;
        return this.data.tokens[instanceId] ?? null;
    }
    setToken(instanceId, token) {
        if (!instanceId)
            throw new Error('setToken: instanceId is required');
        if (!token)
            throw new Error('setToken: token is required');
        this.data.tokens[instanceId] = token;
        this.write();
    }
    /**
     * A corrupt or unreadable file is replaced rather than fatal: the only cost is a silent
     * re-pair on the next hello, and refusing to start would be a worse trade.
     */
    read() {
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
            if (typeof parsed?.serverId === 'string' && parsed.serverId) {
                return {
                    version: 1,
                    serverId: parsed.serverId,
                    tokens: this.readTokens(parsed.tokens),
                };
            }
        }
        catch {
            // Missing or damaged, fall through to a fresh identity
        }
        const fresh = { version: 1, serverId: randomUUID(), tokens: {} };
        this.data = fresh;
        this.write();
        return fresh;
    }
    readTokens(tokens) {
        if (!tokens || typeof tokens !== 'object')
            return {};
        return Object.fromEntries(Object.entries(tokens).filter((entry) => typeof entry[1] === 'string'));
    }
    write() {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    }
}
