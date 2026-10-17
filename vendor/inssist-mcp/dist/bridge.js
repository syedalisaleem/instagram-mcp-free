import { PACKAGE_NAME, PEER_RETRY_MS, START_RETRY_WINDOW_MS } from './constants.js';
import { BridgeHub } from './bridge-hub.js';
import { BridgePeer } from './bridge-peer.js';
export class Bridge {
    options;
    /** The role object behind the facade; read-only, for tests and diagnostics. */
    link = null;
    closed = false;
    constructor(options) {
        this.options = options;
    }
    /**
     * Rejects only when, for the whole retry window, the port stays taken by something that is
     * not a hub or cannot be bound at all. A hub that is still shutting down (EADDRINUSE on bind,
     * then ECONNRESET or ECONNREFUSED on the peer dial) clears within that window.
     */
    async start() {
        const deadline = Date.now() + START_RETRY_WINDOW_MS;
        for (;;) {
            try {
                await this.becomeHubOrPeer();
                return;
            }
            catch (error) {
                if (this.closed || Date.now() >= deadline)
                    throw error;
                this.options.log(`Bridge start failed (${error.message || String(error)}), retrying`);
                await new Promise(resolve => setTimeout(resolve, PEER_RETRY_MS));
            }
        }
    }
    get role() {
        return this.link?.role ?? 'hub';
    }
    get activeInstanceId() {
        return this.link?.activeInstanceId ?? null;
    }
    get manifest() {
        return this.link?.manifest ?? null;
    }
    get instances() {
        return this.link?.instances ?? [];
    }
    get lastRejection() {
        return this.link?.lastRejection ?? null;
    }
    get active() {
        return this.activeInstanceId !== null;
    }
    call(tool, params, instanceId, instant) {
        if (!this.link)
            return Promise.reject(new Error('No paired INSSIST extension is connected'));
        return this.link.call(tool, params, instanceId, instant);
    }
    waitForActive(timeoutMs) {
        if (!this.link)
            return Promise.resolve(false);
        return this.link.waitForActive(timeoutMs);
    }
    close() {
        this.closed = true;
        this.link?.close();
        this.link = null;
    }
    // MARK: Roles
    // ============================================================================
    async becomeHubOrPeer() {
        const hub = new BridgeHub({
            port: this.options.port,
            version: this.options.version,
            pairings: this.options.pairings,
            onToolsChanged: this.options.onToolsChanged,
            log: this.options.log,
        });
        try {
            await hub.start();
            this.link = hub;
            this.options.log(`Bridge on 127.0.0.1:${hub.port} (hub)`);
            return;
        }
        catch (error) {
            if (error.code !== 'EADDRINUSE')
                throw error;
        }
        await this.becomePeer();
    }
    async becomePeer() {
        const peer = new BridgePeer({
            port: this.options.port,
            version: this.options.version,
            onStateChanged: this.options.onToolsChanged,
            onLost: () => void this.onHubLost(),
            log: this.options.log,
        });
        await peer.start();
        this.link = peer;
        this.options.log(`Joined the running ${PACKAGE_NAME} on 127.0.0.1:${this.options.port} as a peer`);
    }
    /**
     * The hub's harness closed. Race for the port; losing just means another peer got there
     * first and is the hub now, so dial again after a beat. Keep trying until this process is
     * itself shut down: a harness that stays open must not end up bridgeless.
     */
    async onHubLost() {
        this.link = null;
        while (!this.closed) {
            try {
                await this.becomeHubOrPeer();
                this.options.onToolsChanged();
                return;
            }
            catch (error) {
                this.options.log(`Bridge re-attach failed (${error.message || String(error)}), retrying`);
                await new Promise(resolve => setTimeout(resolve, PEER_RETRY_MS));
            }
        }
    }
}
