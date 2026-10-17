import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { BRIDGE_HOST, CALL_TIMEOUT_MS, PEER_PATH, PROTOCOL_VERSION } from './constants.js';
export class BridgePeer {
    role = 'peer';
    options;
    pending = new Map();
    readyWaiters = new Set();
    socket = null;
    closed = false;
    activeInstanceId = null;
    manifest = null;
    instances = [];
    lastRejection = null;
    constructor(options) {
        this.options = options;
    }
    /** Resolves once the hub has answered `peer-hello`; rejects if it cannot be reached at all. */
    async start() {
        const socket = new WebSocket(`ws://${BRIDGE_HOST}:${this.options.port}${PEER_PATH}`);
        this.socket = socket;
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            socket.once('error', onError);
            socket.once('open', () => {
                socket.off('error', onError);
                this.send({ t: 'peer-hello', v: PROTOCOL_VERSION, version: this.options.version, pid: process.pid });
                resolve();
            });
        });
        socket.on('message', data => this.onFrame(String(data)));
        socket.on('error', error => this.options.log(`Peer socket error: ${String(error)}`));
        socket.on('close', () => this.onClose());
    }
    get active() {
        return this.activeInstanceId !== null;
    }
    async call(tool, params, instanceId, instant) {
        if (!tool)
            throw new Error('call: tool name is required');
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('No paired INSSIST extension is connected');
        }
        const id = randomUUID();
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Tool "${tool}" timed out after ${Math.round(CALL_TIMEOUT_MS / 1000)}s`));
            }, CALL_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.send({ t: 'peer-call', id, tool, params, instanceId, instant });
        });
    }
    waitForActive(timeoutMs) {
        if (this.active)
            return Promise.resolve(true);
        return new Promise(resolve => {
            const done = (ready) => {
                clearTimeout(timer);
                this.readyWaiters.delete(wake);
                resolve(ready);
            };
            const wake = () => done(true);
            const timer = setTimeout(() => done(false), timeoutMs);
            this.readyWaiters.add(wake);
        });
    }
    close() {
        this.closed = true;
        this.failPending('Bridge is shutting down');
        this.readyWaiters.forEach(wake => wake());
        this.socket?.close();
        this.socket = null;
    }
    // MARK: Frames
    // ============================================================================
    onFrame(data) {
        let frame;
        try {
            frame = JSON.parse(data);
        }
        catch {
            return;
        }
        if (!frame || typeof frame !== 'object')
            return;
        if (frame.t === 'peer-state')
            return this.onState(frame);
        if (frame.t === 'peer-result')
            return this.settle(frame.id, frame.result, null);
        if (frame.t === 'peer-error')
            return this.settle(frame.id, null, frame.message || 'Tool call failed');
    }
    onState(frame) {
        const wasActive = this.active;
        this.activeInstanceId = frame.activeInstanceId ?? null;
        this.manifest = Array.isArray(frame.manifest) ? frame.manifest : null;
        this.instances = Array.isArray(frame.instances) ? frame.instances : [];
        this.lastRejection = frame.lastRejection ?? null;
        if (!wasActive && this.active)
            this.readyWaiters.forEach(wake => wake());
        this.options.onStateChanged();
    }
    onClose() {
        this.socket = null;
        this.activeInstanceId = null;
        this.manifest = null;
        this.instances = [];
        this.failPending('The bridge hub went away; retry the call');
        if (this.closed)
            return;
        this.options.log('Hub connection lost');
        this.options.onStateChanged();
        this.options.onLost();
    }
    settle(id, result, error) {
        const call = this.pending.get(id);
        if (!call)
            return;
        this.pending.delete(id);
        clearTimeout(call.timer);
        if (error)
            call.reject(new Error(error));
        else
            call.resolve(result);
    }
    failPending(message) {
        this.pending.forEach(call => {
            clearTimeout(call.timer);
            call.reject(new Error(message));
        });
        this.pending.clear();
    }
    send(frame) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
            return;
        this.socket.send(JSON.stringify(frame));
    }
}
