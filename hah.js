(function () {
    let scene;
    let currentScript = document.currentScript;

    const DOMAIN = "https://banter-hah.firer.at/";
    const MAX_PLAYERS = 10;
    const MAX_HAND_CARDS = 12;
    const MAX_SUPPORTED_RESPONSES = 3;
    // Removed: let STATE_KEY = "hah_game";
    const IDLE_TIMEOUT_SECONDS = 90;
    const DISCONNECT_TIMEOUT_SECONDS = 45;

    class CAHDeck {
        _hydrateCompact(json) {
            let packs = [];
            let sourcePacks = json.packs || (json.metadata ? Object.values(json.metadata) : []);
            for (let pack of sourcePacks) {
            pack.white = pack.white.map((index) =>
                Object.assign(
                {},
                { text: json.white[index] },
                { pack: packs.length },
                pack.icon ? { icon: pack.icon } : {}
                )
            );
            pack.black = pack.black.map((index) =>
                Object.assign(
                {},
                typeof json.black[index] === 'string' ? { text: json.black[index] } : json.black[index],
                { pack: packs.length },
                pack.icon ? { icon: pack.icon } : {}
                )
            );
            packs.push(pack);
            }
            return packs;
        }

        async _loadDeck() {
            if (typeof this.compactSrc != "undefined") {
            let json = await fetch(this.compactSrc).then((data) => data.json());
            this.deck = this._hydrateCompact(json);
            } else if (typeof this.fullSrc != "undefined") {
            this.deck = await fetch(this.fullSrc).then((data) => data.json());
            } else {
            throw Error(
                "No source specified, please use CAHDeck.fromCompact(src) or CAHDeck.fromFull(src) to make your objects."
            );
            }
        }

        static async fromCompact(compactSrc) {
            let n = new CAHDeck();
            n.compactSrc = compactSrc;
            await n._loadDeck();
            return n;
        }

        static async fromFull(fullSrc) {
            let n = new CAHDeck();
            n.fullSrc = fullSrc;
            await n._loadDeck();
            return n;
        }

        listPacks() {
            let packs = [];
            let id = 0;
            for (let { name, official, description, icon, white, black } of this.deck) {
            let pack = {
                id,
                name,
                official,
                description,
                counts: {
                white: white.length,
                black: black.length,
                total: white.length + black.length,
                },
            };
            if (icon) {
                pack.icon = icon;
            }
            packs.push(pack);
            id += 1;
            }
            return packs;
        }

        getPack(index) {
            return this.deck[index];
        }

        getPacks(indexes) {
            if (typeof indexes == "undefined") {
            indexes = Object.keys(this.deck);
            }
            let white = [];
            let black = [];
            for (let pack of indexes) {
            if (typeof this.deck[pack] != "undefined") {
                white.push(...this.deck[pack].white);
                black.push(...this.deck[pack].black);
            }
            }
            return { white, black };
        }
    }

    class BullshcriptGame {
        constructor() {
            this.gameState = null;
            this.selectedCardIds = [];
            this.hasSubmittedThisRound = false;
            this.ui = {
                slices: [],
                centralPanel: null,
                czarResponseCards: []
            };
            this.isConfirmationDialogOpen = false;
            this.confirmCallback = null;
            this.isMuted = false;
            this.playersInitiallyLoaded = {}; // Track initial connected state for sound suppression
            this.joinTime = Date.now();

            const urlParams = new URLSearchParams(window.location.search);
            const getParam = (attr, defaultValue) => {
                return urlParams.get(attr) || 
                       (currentScript && currentScript.getAttribute(attr)) || 
                       (currentScript && currentScript.dataset?.[attr]) || 
                       defaultValue;
            };

            this.params = {
                position: getParam("position", "0 0 0"),
                rotation: getParam("rotation", "0 0 0"),
                instance: getParam("instance", "hah_game"),
                debug: getParam("debug", "false") === "true"
            };
            this.stateKey = this.params.instance; // Changed STATE_KEY to this.stateKey
        }

        wrapText(text, maxChars = 19) {
            if (!text) return "";
            // Strip any existing newlines and replace with spaces, then collapse extra whitespace
            const words = text.replace(/\n/g, ' ').split(/\s+/).filter(word => word.length > 0);
            const lines = [];
            let currentLine = "";

            for (const word of words) {
                // Check if adding this word (plus a space if needed) exceeds the limit
                const testLine = currentLine.length > 0 ? currentLine + word : word;
                if (testLine.length > maxChars) {
                    if (currentLine.length > 0) {
                        lines.push(currentLine.trim());
                        currentLine = word + " ";
                    } else {
                        // Word itself is too long, force it onto a line
                        lines.push(word);
                        currentLine = "";
                    }
                } else {
                    currentLine = testLine + " ";
                }
            }

            if (currentLine.trim().length > 0) {
                lines.push(currentLine.trim());
            }

            return lines.join('\n');
        }

        parseVector3(str) {
            const parts = str.split(" ").map(parseFloat);
            return new BS.Vector3(parts[0] || 0, parts[1] || 0, parts[2] || 0);
        }

        log(...args) {
            if (this.params.debug) console.log("[HAH Banter]", ...args);
        }

        playLocalSound(soundFile) { // This will be called by sync
            if (this.isMuted) return;
            const audio = new Audio(`${DOMAIN}Assets/${soundFile}`);
            audio.crossOrigin = "anonymous";
            audio.volume = 0.3;
            audio.play().catch(e => this.log("Sound play error:", e));
        }

        async init() {
            if (scene) return;
            scene = BS.BanterScene.GetInstance();

            this.log("Initializing Serverless HAH...");
            
            // Load deck data first so UI can be built with it
            await this.loadDeck();

            if (!scene.unityLoaded) {
                await new Promise(resolve => {
                    scene.On("unity-loaded", resolve);
                    window.addEventListener("unity-loaded", resolve, { once: true });
                });
            }

            await this.buildEnvironment();

            // Listen for state changes
            scene.On("space-state-changed", this.onSpaceStateChanged.bind(this));
            scene.On("user-left", this.onSpaceUserLeft.bind(this));

            // Initial sync
            this.sync();

            setInterval(() => this.tick(), 1000);
        }

        async loadDeck() {
            try {
                this.log(`Loading decks from compact json...`);
                this.cahDeck = await CAHDeck.fromCompact(`${DOMAIN}decks/cah-all-compact.json`);
                this.availablePacks = this.cahDeck.listPacks(); // No sorting for now to test stability
                
                const basePack = this.availablePacks.find(p => p.name === 'CAH Base Set') || this.availablePacks[0];
                this.defaultSelectedPacks = [basePack.id];
                
                this.log("Deck loaded successfully.");
            } catch (err) {
                this.log("Error loading deck:", err);
            }
        }

        onSpaceStateChanged(e) {
            if (e.detail.changes.some(c => c.property === this.stateKey)) { // Changed STATE_KEY to this.stateKey
                this.sync();
            }
        }

        onSpaceUserLeft(e) {
            const userId = e.detail.uid;
            if (this.gameState && this.gameState.players[userId]) {
                this.log(`Player ${userId} left the space.`);
                // Host will handle the removal logic in driveHostLogic
            }
        }

        sync() {
            if (!scene || !scene.spaceState) return;
            const raw = scene.spaceState.public[this.stateKey]; // Changed STATE_KEY to this.stateKey
            let newState;
            try {
                newState = raw ? JSON.parse(raw) : null;
            } catch (err) {
                this.log("Error parsing state:", err);
                return;
            }

            if (!newState) {
                if (!this.gameState) {
                    this.gameState = this.getDefaultState();
                }
                this.playersInitiallyLoaded = {}; // Clear if state is reset
            } else {
                // Check for sound to play
                const oldSound = this.gameState ? this.gameState.lastSound : null;
                if (newState.lastSound && (!oldSound || newState.lastSound.ts !== oldSound.ts)) {
                    if (newState.lastSound.ts > this.joinTime) {
                        this.playLocalSound(newState.lastSound.file);
                    }
                }

                if (JSON.stringify(this.gameState) !== JSON.stringify(newState)) {
                    const prevWinner = this.gameState?.winner;
                    this.gameState = newState;
                    if (prevWinner && !this.gameState.winner) {
                        this.selectedCardIds = [];
                    }
                    // Populate playersInitiallyLoaded only once upon first valid state sync
                    if (Object.keys(this.playersInitiallyLoaded).length === 0) {
                        for (const playerId in this.gameState.players) {
                            this.playersInitiallyLoaded[playerId] = this.gameState.players[playerId].connected;
                        }
                    }
                }
            }
            this.updateUI();
        }

        getDefaultState() {
            return {
                players: {},
                waitingRoom: [],
                czar: null,
                currentBlackCard: null,
                currentPreviewResponse: 0,
                showBlack: false,
                blackDeck: [],
                whiteDeck: [],
                blackDiscard: [],
                whiteDiscard: [],
                isStarted: false,
                winner: null,
                round: 0,
                currentHostUid: null,
                lastAction: null,
                lastSound: null, // Add lastSound to default state
                selectedPacks: []
            };
        }

        async updateState(patch) {
            if (!this.gameState) return;
            Object.assign(this.gameState, patch);

            // If a sound was triggered during logic, sync it
            if (this.gameState._triggerSound) {
                this.gameState.lastSound = { file: this.gameState._triggerSound, ts: Date.now() };
                delete this.gameState._triggerSound;
            }
            
            await scene.SetPublicSpaceProps({ [this.stateKey]: JSON.stringify(this.gameState) });
            // Do NOT call sync() here, it will overwrite our local changes with stale space data
            // until the network update actually propagates back to us.
            this.updateUI();
        }

        async sendAction(action, data = {}, senderUid = null) {
            if (!scene?.localUser || !scene?.spaceState) return;
            
            const localUid = senderUid || scene.localUser.uid;
            const localName = scene.localUser.name;

            for (let attempt = 0; attempt < 5; attempt++) {
                const raw = scene.spaceState.public[this.stateKey];
                let state;
                try {
                    state = raw ? JSON.parse(raw) : this.getDefaultState();
                } catch (err) {
                    state = this.getDefaultState();
                }

                // Check if our action is already there (e.g. from a successful previous attempt that we thought failed)
                if (state.lastAction && state.lastAction.userId === localUid && state.lastAction.action === action && JSON.stringify(state.lastAction.data) === JSON.stringify(data)) {
                    // Action already reflected, no need to retry
                    this.sync();
                    return;
                }

                const updated = this.applyGameLogic(state, action, localUid, localName, data);
                if (!updated) return;

                if (updated._triggerSound) {
                    updated.lastSound = { file: updated._triggerSound, ts: Date.now() };
                    delete updated._triggerSound;
                }
                
                const actionId = Math.random().toString(36).substring(7);
                updated.lastAction = { action, userId: localUid, data, timestamp: Date.now(), id: actionId };

                await scene.SetPublicSpaceProps({ [this.stateKey]: JSON.stringify(updated) });
                
                // Short delay to let the space settle, then verify if our change persisted
                await new Promise(r => setTimeout(r, 200));
                const postRaw = scene.spaceState.public[this.stateKey];
                
                // If the current space state contains our unique action ID, we succeeded!
                if (postRaw && postRaw.includes(actionId)) {
                    this.gameState = updated; // Update local state immediately
                    this.updateUI();
                    return;
                }
                
                this.log(`Action ${action} stomped or slow, retrying (attempt ${attempt + 1})...`);
                // Random jitter before retry to reduce further collisions
                await new Promise(r => setTimeout(r, 100 + Math.random() * 300));
            }
            this.log(`Failed to deliver action ${action} after 5 attempts.`);
        }

        isHost() {
            if (!scene || !scene.localUser) return false;
            if (!this.gameState || !this.gameState.currentHostUid) {
                const uids = Object.keys(scene.users || {}).sort();
                return uids.length > 0 && uids[0] === scene.localUser.uid;
            }
            return this.gameState.currentHostUid === scene.localUser.uid;
        }

        async tick() {
            if (!this.gameState || !scene?.localUser) return;
            const now = Date.now();
            const localUid = scene.localUser.uid;

            if (this.isHost()) {
                // Protect against stomping: If a player recently performed an action, 
                // wait for it to propagate before the Host logic runs and potentially overwrites it.
                const lastAction = this.gameState.lastAction;
                if (lastAction && lastAction.userId !== localUid && (now - lastAction.timestamp < 1500)) {
                    // Skip this tick to let player state settle
                    this.updateUI();
                    return;
                }
                this.driveHostLogic();
            }
            this.updateUI();
        }

        startDeckAnimation() {
            if (this._deckAnimRunning) return; // only start once
            this._deckAnimRunning = true;

            const baseY = 1.15;
            const spinSpeed = 18; // degrees per second for Y spin
            let lastTime = performance.now();
            let rotY = 0;

            // Pre-allocate vectors once to avoid GC pressure at 72fps on Quest
            const pos = new BS.Vector3(0, baseY, 0);
            const rot = new BS.Vector3(0, 0, 0);

            const loop = (now) => {
                if (!this.ui.deckObj) return; // stop if object destroyed

                const dt = Math.min((now - lastTime) / 1000, 0.1); // delta seconds, capped
                lastTime = now;

                // Continuous Y spin
                rotY = (rotY + spinSpeed * dt) % 360;

                // Gentle bob using absolute time so it's always smooth
                const t = now / 1000;
                pos.y = baseY + Math.sin(t * 1.2) * 0.04;

                // Smooth lerp toward flip target on Z axis
                // Z=0 when idle, Z=180 when game is started
                const targetRotZ = this.gameState?.isStarted ? 0 : 180;
                this._deckRotZ += (targetRotZ - this._deckRotZ) * Math.min(dt * 5, 1);

                // Mutate pre-allocated vectors in-place (no GC allocation per frame)
                rot.y = rotY;
                rot.z = this._deckRotZ;

                this.ui.deckObj.transform.localPosition = pos;
                this.ui.deckObj.transform.localEulerAngles = rot;

                requestAnimationFrame(loop);
            };

            requestAnimationFrame(loop);
        }

        driveHostLogic() {
            const now = Date.now();
            let changed = false;
            const patch = {};

            // 1. Host Assignment
            if (!this.gameState.currentHostUid || !scene.users[this.gameState.currentHostUid]) {
                const uids = Object.keys(scene.users || {}).sort();
                if (uids.length > 0 && uids[0] !== this.gameState.currentHostUid) {
                    patch.currentHostUid = uids[0];
                    changed = true;
                }
            }

            // 2. Player Removal (Inactivity/Disconnect)
            const playerIds = Object.keys(this.gameState.players);
            playerIds.forEach(uid => {
                const p = this.gameState.players[uid];
                if (!p) return; // Player might have been removed by a previous action in this loop

                const isConnected = !!scene.users[uid];

                // Update connected status in state
                if (p.connected !== isConnected) {
                    p.connected = isConnected;
                    if (!isConnected) p.disconnectTime = now;
                    else p.disconnectTime = 0;
                    changed = true;
                }

                // Disconnect Kick
                if (!isConnected && p.disconnectTime > 0) {
                    if (now - p.disconnectTime > DISCONNECT_TIMEOUT_SECONDS * 1000) {
                        this.log(`Kicking ${p.name} for disconnect.`);
                        const wasInitiallyConnected = this.playersInitiallyLoaded.hasOwnProperty(uid) && this.playersInitiallyLoaded[uid];
                        this.applyGameLogic(this.gameState, "leave-game", uid, p.name, { playSound: wasInitiallyConnected });
                        changed = true;
                    }
                }

                // Inactivity Kick (Only if game started)
                if (this.gameState.isStarted && p.inactivityKickTime > 0) {
                    if (now > p.inactivityKickTime) {
                        this.log(`Kicking ${p.name} for inactivity.`);
                        this.applyGameLogic(this.gameState, "leave-game", uid, p.name, { playSound: true });
                        changed = true;
                    }
                }
            });

            // 3. Auto-start next round after winner chosen
            if (this.gameState.winner && this.gameState.winnerTime) {
                if (now - this.gameState.winnerTime > 5000) {
                    this.log("Auto-starting next round...");
                    this.applyGameLogic(this.gameState, "start-game", scene.localUser.uid, scene.localUser.name, {});
                    changed = true;
                }
            }

            if (changed) {
                this.updateState(patch);
            }
        }

        initializeNewRound(state) {
            const players = Object.keys(state.players);
            if (players.length < 3) {
                state.isStarted = false;
                return state;
            }

            // Czar Rotation
            if (!state.czar || !state.players[state.czar]) {
                state.czar = players[0];
            } else {
                const currentIdx = players.indexOf(state.czar);
                state.czar = players[(currentIdx + 1) % players.length];
            }

            // Reset round state
            state.showBlack = false;
            state.winner = null;
            state.winnerTime = 0; // Reset winner time
            state.currentPreviewResponse = 0;
            state.round++;

            // Clear inactivity timers
            players.forEach(uid => {
                const p = state.players[uid];
                p.selected = [];
                p.inactivityKickTime = 0;
                
                // Refill Hand
                if (p.wantsNewHand) {
                    if (p.cards) state.whiteDiscard.push(...p.cards.filter(Boolean));
                    p.cards = [];
                    p.wantsNewHand = false;
                }
                p.hasRequestedHandDumpThisRound = false;

                // Draw up to 12
                while (p.cards.length < 12) {
                    const card = this.drawWhiteCard(state);
                    if (!card) break;
                    p.cards.push(card);
                }
            });

            // Draw Black Card
            state.currentBlackCard = this.drawBlackCard(state);
            state.isStarted = true;

            // Set Czar inactivity timer to reveal black card
            if (state.players[state.czar]) {
                state.players[state.czar].inactivityKickTime = Date.now() + (IDLE_TIMEOUT_SECONDS * 1000);
            }

            this.log(`New round started. Czar: ${state.czar}, Card: ${state.currentBlackCard?.text?.substring(0, 30)}...`);
            return state;
        }

        drawWhiteCard(state) {
            if (state.whiteDeck.length === 0) {
                if (state.whiteDiscard.length === 0) {
                    // Reshuffle from master for current packs
                    const selectedIds = state.selectedPacks && state.selectedPacks.length > 0 ? state.selectedPacks : this.defaultSelectedPacks;
                    const combined = this.cahDeck.getPacks(selectedIds);
                    let cardIdCounter = 0;
                    state.whiteDeck = combined.white.map(card => ({ 
                        ...card, 
                        _id: `w_${cardIdCounter++}` 
                    })).sort(() => Math.random() - 0.5);
                } else {
                    state.whiteDeck = [...state.whiteDiscard].sort(() => Math.random() - 0.5);
                    state.whiteDiscard = [];
                }
            }
            return state.whiteDeck.pop();
        }

        drawBlackCard(state) {
            if (state.blackDeck.length === 0) {
                if (state.blackDiscard.length === 0) {
                    const selectedIds = state.selectedPacks && state.selectedPacks.length > 0 ? state.selectedPacks : this.defaultSelectedPacks;
                    const combined = this.cahDeck.getPacks(selectedIds);
                    let cardIdCounter = 0;
                    state.blackDeck = combined.black.map(card => ({ 
                        ...(typeof card === 'string' ? { text: card } : card), 
                        _id: `b_${cardIdCounter++}`,
                        numResponses: card.pick || card.numResponses || 1 
                    })).sort(() => Math.random() - 0.5);
                } else {
                    state.blackDeck = [...state.blackDiscard].sort(() => Math.random() - 0.5);
                    state.blackDiscard = [];
                }
            }
            const card = state.blackDeck.pop();
            if (card) state.blackDiscard.push(card);
            return card;
        }

        applyGameLogic(state, action, userId, userName, data) {
            this.log(`Action: ${action} by ${userName}`);
            
            const players = state.players;
            const player = players[userId];

            switch (action) {
                case "claim-host":
                    state.currentHostUid = userId;
                    break;

                case "update-decks":
                    if (this.isHost() && (!state.isStarted || state.winner)) {
                        state.selectedPacks = data;
                        this.log("Packs updated:", data);
                        this.triggerSound(state, "card_flick.ogg");
                    }
                    break;

                case "join-game":
                    if (!player && Object.keys(players).length < MAX_PLAYERS) {
                        const occupied = new Set(Object.values(players).map(p => p.position));
                        let pos = -1;
                        const available = [0,1,2,3,4,5,6,7,8,9].filter(p => !occupied.has(p));
                        if (available.length > 0) {
                            pos = available[Math.floor(Math.random() * available.length)];
                        }

                        players[userId] = {
                            _id: userId,
                            name: userName,
                            trophies: 0,
                            cards: [],
                            selected: [],
                            position: pos,
                            connected: true,
                            disconnectTime: 0,
                            inactivityKickTime: 0,
                            wantsNewHand: false,
                            hasRequestedHandDumpThisRound: false
                        };
                        this.triggerSound(state, "playerJoin.ogg");
                    }
                    break;

                case "leave-game":
                    if (players[userId]) {
                        const p = players[userId];
                        if (p.cards) state.whiteDiscard.push(...p.cards.filter(Boolean));
                        if (p.selected) state.whiteDiscard.push(...p.selected.filter(Boolean));
                        
                        const wasCzar = state.czar === userId;
                        delete players[userId];

                        if (Object.keys(players).length < 3 || wasCzar) {
                            state.isStarted = false;
                            state.winner = null;
                            state.czar = null;
                        }
                        // Conditionally trigger sound
                        if (data.playSound !== false) { // playSound is passed in data from driveHostLogic
                            this.triggerSound(state, "playerKick.ogg");
                        }
                    }
                    break;

                case "start-game":
                    if (this.isHost() && (!state.isStarted || state.winner) && Object.keys(players).length >= 3) {
                        state = this.initializeNewRound(state);
                        this.triggerSound(state, "gameStart.ogg");
                    }
                    break;

                case "show-black":
                    if (state.czar === userId) {
                        state.showBlack = true;
                        // Clear Czar timer
                        if (player) player.inactivityKickTime = 0;
                        // Set timers for responders
                        const now = Date.now();
                        Object.values(players).forEach(p => {
                            // Only set inactivity timer for players who actually have cards (participating in this round)
                            if (p._id !== state.czar && p.cards && p.cards.length > 0) {
                                p.inactivityKickTime = now + (IDLE_TIMEOUT_SECONDS * 1000);
                            }
                        });
                        this.triggerSound(state, "card_flick.ogg");
                    }
                    break;

                case "choose-cards":
                    if (player && !player.selected.length) {
                        const numReq = state.currentBlackCard?.numResponses || 1;
                        if (data.length === numReq) {
                            player.selected = data;
                            player.inactivityKickTime = 0;
                            
                            // Remove from hand
                            const submittedIds = data.map(c => c._id);
                            player.cards = player.cards.filter(c => !submittedIds.includes(c._id));

                            // If all submitted, set Czar timer
                            const activeResponders = Object.values(players).filter(p => p._id !== state.czar && ((p.cards && p.cards.length > 0) || (p.selected && p.selected.length > 0)));
                            if (activeResponders.length > 0 && activeResponders.every(p => p.selected.length > 0)) {
                                if (state.players[state.czar]) {
                                    state.players[state.czar].inactivityKickTime = Date.now() + (IDLE_TIMEOUT_SECONDS * 1000);
                                }
                            }
                            this.triggerSound(state, "card_flick.ogg");
                        }
                    }
                    break;

                case "preview-response":
                    if (state.czar === userId) {
                        state.currentPreviewResponse = data;
                        this.triggerSound(state, "card_flick.ogg");
                    }
                    break;

                case "choose-winner":
                    if (state.czar === userId && !state.winner) {
                        const winnerPlayer = players[data];
                        if (winnerPlayer) {
                            winnerPlayer.trophies++;
                            state.winner = { ...winnerPlayer }; // Copy for display
                            state.winnerTime = Date.now();
                             
                            // Czar acted, clear timer
                            if (player) player.inactivityKickTime = 0;
                        }
                        this.triggerSound(state, "fanfare with pop.ogg");
                    }
                    break;

                case "dump-hand":
                    if (player && state.czar !== userId && !player.hasRequestedHandDumpThisRound) {
                        player.wantsNewHand = true;
                        player.hasRequestedHandDumpThisRound = true;
                        this.triggerSound(state, "card_flick.ogg");
                    }
                    break;
            }

            state.lastAction = { action, userId, data, timestamp: Date.now() };
            return state;
        }
        
        // Removed handleActionSound as its logic is now integrated into sync and triggerSound

        async buildEnvironment() {
            const rootPos = this.parseVector3(this.params.position);
            const rootRot = this.parseVector3(this.params.rotation);
            this.root = await new BS.GameObject({ name: "HAH_Root", localPosition: rootPos, localEulerAngles: rootRot }).Async();

            // Main Table Base (Circle)
            const tableObj = await new BS.GameObject({ name: "HAH_TableBase", parent: this.root, localPosition: new BS.Vector3(0, 1, 0), localEulerAngles: new BS.Vector3(90, 0, 0) }).Async();
            await tableObj.AddComponent(new BS.BanterCircle({
                radius: 1.5,
                segments: 32,
                thetaStart: 0,
                thetaLength: Math.PI * 2
            }));
            await tableObj.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.08, 0.08, 0.1, 1) }));

            // Center Deck - GLB Model (box.glb)
            // Scale the GLB to taste — adjust localScale values as needed
            const deckObj = await new BS.GameObject({ 
                name: "HAH_Deck", 
                parent: this.root, 
                localPosition: new BS.Vector3(0, 1.15, 0),
                localScale: new BS.Vector3(2.5, 2.5, 2.5)
            }).Async();
            try {
                await deckObj.AddComponent(new BS.BanterGLTF(`${DOMAIN}Assets/box.glb`, false, false, false, false, false, false));
            } catch (glbErr) {
                this.log("Failed to load box.glb, falling back to box:", glbErr);
                await deckObj.AddComponent(new BS.BanterBox({ width: 0.3, height: 0.1, depth: 0.2 }));
                await deckObj.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.15, 0.15, 0.15, 1) }));
            }
            this.ui.deckObj = deckObj;
            this._deckRotZ = 0; // tracks smooth flip state
            this.startDeckAnimation();

            // Player Slices
            this.ui.slices = [];
            for (let i = 0; i < MAX_PLAYERS; i++) {
                this.ui.slices.push(await this.buildPlayerSlice(i));
            }

            // Central Hub UI
            await this.buildCentralUI();

            this.log("Environment built.");
        }

        async buildPlayerSlice(index) {
            const angleDeg = (360 / MAX_PLAYERS) * index;
            const sliceRoot = await new BS.GameObject({ 
                name: `HAH_PlayerSlice_${index}`, 
                parent: this.root, 
                localEulerAngles: new BS.Vector3(0, angleDeg, 0) 
            }).Async();

            // Geometric Wedge for the placemat
            const wedgeObj = await new BS.GameObject({ name: "HAH_Placemat", parent: sliceRoot, localPosition: new BS.Vector3(0, 1.01, 0), localEulerAngles: new BS.Vector3(90, 0, 0) }).Async();
            const sliceAngleRad = Math.PI * 2 / MAX_PLAYERS;
            await wedgeObj.AddComponent(new BS.BanterCircle({
                radius: 1.6,
                segments: 8,
                thetaStart: (Math.PI / 2) - (sliceAngleRad * 0.95) / 2,
                thetaLength: sliceAngleRad * 0.95
            }));
            // Tiles need unique material instances for dynamic color highlighting
            const matNormal = await wedgeObj.AddComponent(new BS.BanterMaterial(
                "Unlit/Color", 
                null, 
                new BS.Vector4(0.15, 0.15, 0.15, 1), 
                0, // BS.MaterialSide.Front
                false, 
                "HAH_Wedge_" + index
            ));

            // 1. Status Bar UI (Always visible if player is present, near table edge)
            const statusObj = await new BS.GameObject({ 
                name: "HAH_StatusUI", 
                parent: sliceRoot, 
                localPosition: new BS.Vector3(0, 1.15, 1.55), 
                localEulerAngles: new BS.Vector3(35, 180, 0), 
                localScale: new BS.Vector3(0.10, 0.10, 0.10) 
            }).Async();
            
            const sPanel = await statusObj.AddComponent(new BS.BanterUI(new BS.Vector2(750, 130), false));
            const sRoot = sPanel.CreateVisualElement();
            await sRoot.Async();
            sRoot.SetStyles({
                backgroundColor: 'rgba(20, 20, 20, 0.93)',
                display: 'none',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '40px',
                width: '100%',
                height: '100%',
                paddingLeft: '30px',
                paddingRight: '30px',
                borderRadius: '40px',
                borderWidth: '4px',
                borderColor: '#666666'
            });

            if (sRoot.parent && sRoot.parent.SetStyles) {
                sRoot.parent.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)' });
            }

            const nameText = sPanel.CreateLabel(undefined, sRoot);
            await nameText.Async();
            nameText.text = "Empty Seat";
            nameText.SetStyles({ color: 'white', fontSize: '36px', fontWeight: 'bold' });

            const statusText = sPanel.CreateLabel(undefined, sRoot);
            await statusText.Async();
            statusText.text = "";
            statusText.SetStyles({ color: '#ffcc00', fontSize: '32px' });

            const timerText = sPanel.CreateLabel(undefined, sRoot);
            await timerText.Async();
            timerText.text = "";
            timerText.SetStyles({ color: '#ff3333', fontSize: '32px', fontWeight: 'bold' });

            // 2. Hand UI (Only visible to local user, floating/tilted)
            const handObj = await new BS.GameObject({ 
                name: "HAH_HandUI", 
                parent: sliceRoot, 
                localPosition: new BS.Vector3(0, 1.05, 1.68),
                localEulerAngles: new BS.Vector3(60, 180, 0),
                localScale: new BS.Vector3(0.08, 0.08, 0.08)
            }).Async();
            
            const hPanel = await handObj.AddComponent(new BS.BanterUI(new BS.Vector2(900, 2500), false));
            const hRoot = hPanel.CreateVisualElement();
            await hRoot.Async();
            hRoot.SetStyles({
                backgroundColor: 'rgba(25, 25, 25, 0.93)',
                display: 'none',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '20px',
                borderRadius: '25px',
                borderWidth: '3px',
                borderColor: '#666666'
            });

            if (hRoot.parent && hRoot.parent.SetStyles) {
                hRoot.parent.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)' });
            }

            const actionsRow = hPanel.CreateVisualElement(hRoot);
            await actionsRow.Async();
            actionsRow.SetStyles({ 
                display: 'flex', 
                flexDirection: 'row', 
                gap: '20px', 
                marginBottom: '20px',
                backgroundColor: 'rgba(0,0,0,0)'
            });

            const selectionLabel = hPanel.CreateLabel(undefined, actionsRow);
            await selectionLabel.Async();
            selectionLabel.text = "";
            selectionLabel.SetStyles({ color: 'white', fontSize: '28px', fontWeight: 'bold', marginRight: '20px' });

            const createBtn = async (pnl, parent, text, color, handler) => {
                const btn = pnl.CreateButton(parent);
                await btn.Async();
                btn.text = text;
                btn.SetStyles({ backgroundColor: color, color: 'white', paddingTop: '15px', paddingBottom: '15px', paddingLeft: '30px', paddingRight: '30px', borderRadius: '12px', fontSize: '25px', borderWidth: '0px' });
                btn.OnClick(handler);
                return btn;
            };

            const submitBtn = await createBtn(hPanel, actionsRow, "SUBMIT", "#4CAF50", () => {
                if (this._isSubmitting) return;
                const localUid = scene.localUser?.uid;
                const localPlayer = Object.values(this.gameState.players).find(p => p._id === localUid);
                if (!localPlayer) return;

                const cardsToSubmit = this.selectedCardIds.map(id => {
                    const card = localPlayer.cards.find(c => c && c._id === id);
                    return card ? { _id: card._id, text: card.text } : null;
                }).filter(Boolean);

                this.confirm("Submit these cards?", async () => {
                    this._isSubmitting = true;
                    this.updateUI();
                    await this.sendAction("choose-cards", cardsToSubmit);
                    this._isSubmitting = false;
                    this.selectedCardIds = [];
                    this.updateUI();
                });
            });
            const resetBtn = await createBtn(hPanel, actionsRow, "RESET", "#FF9800", () => {
                this.selectedCardIds = [];
                this.updateUI();
            });
            const dumpBtn = await createBtn(hPanel, actionsRow, "DUMP HAND", "#F44336", () => {
                this.confirm("Dump hand ?\nNext Round you will have new cards!", () => {
                    this.sendAction("dump-hand");
                    this.selectedCardIds = [];
                });
            });

            const cardsGrid = hPanel.CreateVisualElement(hRoot);
            await cardsGrid.Async();
            cardsGrid.SetStyles({
                display: 'flex',
                flexWrap: 'wrap',
                flexDirection: 'row',
                justifyContent: 'center',
                gap: '12px',
                width: '100%',
                height: '800px',
                overflow: 'hidden',
                backgroundColor: 'rgba(0,0,0,0)'
            });

            const cardUIs = [];
            for (let i = 0; i < MAX_HAND_CARDS; i++) {
                const cardContainer = hPanel.CreateVisualElement(cardsGrid);
                await cardContainer.Async();
                cardContainer.SetStyles({
                    display: 'none',
                    width: '180px',
                    height: '250px',
                    backgroundColor: '#ffffff',
                    padding: '15px',
                    borderRadius: '12px',
                    borderWidth: '4px',
                    borderColor: '#aaaaaa',
                    flexDirection: 'column',
                    alignItems: 'flex-start'
                });
                
                const cardLabel = hPanel.CreateLabel("", cardContainer);
                await cardLabel.Async();
                cardLabel.SetStyles({
                    width: '100%',
                    height: '100%',
                    color: '#000000',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    textAlign: 'upper-left'
                });

                cardContainer.OnClick(() => this.onCardClick(i));
                cardUIs.push({ container: cardContainer, label: cardLabel });
            }

            return {
                root: sliceRoot,
                wedgeMat: matNormal,
                statusObj, sRoot, nameText, statusText, timerText,
                handObj, hRoot, actionsRow, submitBtn, resetBtn, dumpBtn, selectionLabel, cardsGrid, cardUIs
            };
        }

        async buildCentralUI() {
            const centralObj = await new BS.GameObject({ name: "HAH_CentralUI", parent: this.root, localPosition: new BS.Vector3(0, 2.0, 0), localScale: new BS.Vector3(0.15, 0.15, 0.15) }).Async();
            let centralBillboardObj = await centralObj.AddComponent(new BS.BanterBillboard({ smoothing: 1, enableXAxis: false, enableYAxis: true, enableZAxis: false }));
            centralBillboardObj.enableXAxis = false;
            
            const panel = await centralObj.AddComponent(new BS.BanterUI(new BS.Vector2(900, 1000), false));
            const rootEl = panel.CreateVisualElement();
            await rootEl.Async();

            rootEl.SetStyles({
                backgroundColor: 'rgba(10, 10, 10, 0.9)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '20px',
                borderRadius: '25px',
                borderWidth: '4px',
                borderColor: '#4a4e69',
                width: '900px',
                height: '920px',
                position: 'absolute',
                top: '0',
                left: '0',
                backgroundImage: 'none'
            });

            if (rootEl.parent && rootEl.parent.SetStyles) {
                rootEl.parent.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)' });
            }

            this.ui.centralPanel = { obj: centralObj, panel, rootEl };

            const title = panel.CreateLabel(undefined, rootEl);
            await title.Async();
            title.text = "Holograms Against Humanity";
            title.SetStyles({ color: 'white', fontSize: '42px', fontWeight: 'bold', marginBottom: '15px' });
            this.ui.titleLabel = title;

            const statusLabel = panel.CreateLabel(undefined, rootEl);
            await statusLabel.Async();
            statusLabel.text = "";
            statusLabel.SetStyles({ color: '#ffcc00', fontSize: '24px', marginBottom: '15px', display: 'none' });
            this.ui.statusLabel = statusLabel;

            const buttonsRow = panel.CreateVisualElement(rootEl);
            await buttonsRow.Async();
            buttonsRow.SetStyles({ display: 'flex', backgroundColor: 'rgba(0,0,0,0)', backgroundImage: 'none', flexDirection: 'row', gap: '20px', marginBottom: '20px', borderWidth: '0px', padding: '5px', margin: '5px' });

            const createBtn = async (parent, text, color, handler) => {
                const btn = panel.CreateButton(parent);
                await btn.Async();
                
                if (btn.parent && btn.parent.SetStyles) {
                    btn.parent.SetStyles({ backgroundColor: 'rgba(0,0,0,0)', backgroundImage: 'none' });
                }

                btn.text = text;
                btn.SetStyles({ backgroundColor: color, color: 'white', paddingTop: '15px', paddingBottom: '15px', paddingLeft: '30px', paddingRight: '30px', borderRadius: '8px', fontSize: '24px', borderWidth: '0px', backgroundImage: 'none', margin: '8px' });
                btn.OnClick(handler);
                return btn;
            };

            this.ui.joinBtn = await createBtn(buttonsRow, "JOIN GAME", "#2196F3", () => this.sendAction("join-game"));
            this.ui.dealBtn = await createBtn(buttonsRow, "START ROUND", "#4CAF50", () => this.sendAction("start-game"));
            this.ui.deckOptionsBtn = await createBtn(buttonsRow, "DECK OPTIONS", "#FF9800", () => this.openDeckOptionsUI());
            this.ui.leaveBtn = await createBtn(buttonsRow, "LEAVE GAME", "#F44336", () => this.confirm("Leave game?", () => this.sendAction("leave-game")));
            this.ui.claimHostBtn = await createBtn(buttonsRow, "CLAIM HOST", "#9C27B0", () => this.sendAction("claim-host"));
            this.ui.muteBtn = await createBtn(buttonsRow, "🔊", "#607D8B", () => {
                this.isMuted = !this.isMuted;
                this.ui.muteBtn.text = this.isMuted ? "🔇" : "🔊";
            });

            const creditLabel = panel.CreateLabel(undefined, rootEl);
            await creditLabel.Async();
            creditLabel.text = "Cards Against Humanity LLC\nLicensed under CC BY-NC-SA\ncardsagainsthumanity.com\nAdapted for AltspaceVR by:\nDerogatory, falkrons, schmidtec\nOriginally Ported to Banter by Shane\nSDK Port by FireRat\nCard Data & Logic by Chris Hallberg\nv0.8.4";
            creditLabel.SetStyles({ color: '#aaaaaa', fontSize: '25px', marginTop: '20px', textAlign: 'center' });
            this.ui.creditLabel = creditLabel;

            // Black Card Area
            const blackCardContainer = panel.CreateVisualElement(rootEl);
            await blackCardContainer.Async();
            blackCardContainer.SetStyles({
                display: 'none',
                width: '450px',
                height: '300px',
                backgroundColor: 'black',
                padding: '25px',
                borderRadius: '20px',
                borderWidth: '2px',
                borderColor: 'white',
                marginBottom: '20px',
                flexDirection: 'column',
                alignItems: 'flex-start',
                backgroundImage: 'none'
            });

            const blackCardLabel = panel.CreateLabel(undefined, blackCardContainer);
            await blackCardLabel.Async();
            blackCardLabel.SetStyles({
                width: '100%',
                height: '100%',
                color: 'white',
                fontSize: '22px',
                fontWeight: 'bold',
                textAlign: 'upper-left'
            });

            this.ui.blackCard = { container: blackCardContainer, label: blackCardLabel };
            
            this.ui.blackCard.container.OnClick(() => {
                if (this.gameState?.czar === scene.localUser.uid && !this.gameState?.showBlack) {
                    this.sendAction("show-black");
                }
            });

            // Winner Announcement Label
            const winnerLabel = panel.CreateLabel(undefined, rootEl);
            await winnerLabel.Async();
            winnerLabel.text = "";
            winnerLabel.SetStyles({ 
                display: 'none', 
                color: '#ffcc00', 
                fontSize: '48px', 
                fontWeight: 'bold', 
                marginBottom: '20px',
                backgroundColor: 'rgba(0,0,0,0.5)',
                paddingTop: '10px',
                paddingBottom: '10px',
                paddingLeft: '30px',
                paddingRight: '30px',
                borderRadius: '50px',
                backgroundImage: 'none'
            });
            this.ui.winnerLabel = winnerLabel;

            // Czar Responses Area
            const czarResponsesRow = panel.CreateVisualElement(rootEl);
            await czarResponsesRow.Async();
            czarResponsesRow.SetStyles({ display: 'none', flexDirection: 'row', gap: '15px', marginBottom: '20px', backgroundColor: 'rgba(0,0,0,0)', backgroundImage: 'none' });
            this.ui.czarResponsesRow = czarResponsesRow;

            this.ui.czarResponseCards = [];
            for (let i = 0; i < MAX_SUPPORTED_RESPONSES; i++) {
                const cardContainer = panel.CreateVisualElement(czarResponsesRow);
                await cardContainer.Async();
                cardContainer.SetStyles({
                    display: 'none',
                    width: '260px',
                    height: '320px',
                    backgroundColor: 'white',
                    padding: '20px',
                    borderRadius: '15px',
                    borderWidth: '4px',
                    borderColor: '#aaaaaa',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    margin: '8px',
                    backgroundImage: 'none'
                });

                const cardLabel = panel.CreateLabel(undefined, cardContainer);
                await cardLabel.Async();
                cardLabel.SetStyles({
                    width: '100%',
                    height: '100%',
                    color: 'black',
                    fontSize: '18px',
                    fontWeight: 'bold',
                    textAlign: 'upper-left'
                });

                this.ui.czarResponseCards.push({ container: cardContainer, label: cardLabel });
            }

            // Czar Controls
            const czarControlsRow = panel.CreateVisualElement(rootEl);
            await czarControlsRow.Async();
            czarControlsRow.SetStyles({ display: 'none', flexDirection: 'row', gap: '15px', backgroundColor: 'rgba(0,0,0,0)', backgroundImage: 'none' });
            this.ui.czarControlsRow = czarControlsRow;

            this.ui.czarPrevBtn = await createBtn(czarControlsRow, "PREV", "#555", () => {
                const responders = Object.values(this.gameState.players)
                    .filter(p => p._id !== this.gameState.czar && p.selected && p.selected.length > 0)
                    .sort((a, b) => a._id.localeCompare(b._id));
                const nextIdx = Math.max(0, (this.gameState.currentPreviewResponse || 0) - 1);
                this.sendAction("preview-response", nextIdx);
            });
            this.ui.czarWinnerBtn = await createBtn(czarControlsRow, "CHOOSE WINNER", "#4CAF50", () => {
                const responders = Object.values(this.gameState.players)
                    .filter(p => p._id !== this.gameState.czar && p.selected && p.selected.length > 0)
                    .sort((a, b) => a._id.localeCompare(b._id));
                const activeResponse = responders[this.gameState.currentPreviewResponse || 0];
                if (activeResponse) {
                    this.confirm(`Crown this card(s) the winner?`, () => this.sendAction("choose-winner", activeResponse._id), activeResponse.selected);
                }
            });
            this.ui.czarNextBtn = await createBtn(czarControlsRow, "NEXT", "#555", () => {
                const responders = Object.values(this.gameState.players)
                    .filter(p => p._id !== this.gameState.czar && p.selected && p.selected.length > 0)
                    .sort((a, b) => a._id.localeCompare(b._id));
                const nextIdx = Math.min(responders.length - 1, (this.gameState.currentPreviewResponse || 0) + 1);
                this.sendAction("preview-response", nextIdx);
            });

            // Confirm Dialog UI Overlay
            this.ui.confirmOverlay = panel.CreateVisualElement(rootEl);
            await this.ui.confirmOverlay.Async();
            this.ui.confirmOverlay.SetStyles({
                display: 'none',
                position: 'absolute',
                top: '0', left: '0', width: '100%', height: '100%',
                backgroundColor: 'rgba(10, 10, 10, 0.98)', // proven format
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: '100',
                borderRadius: '25px',
                borderWidth: '0px'
            });

            this.ui.confirmMsg = panel.CreateLabel(undefined, this.ui.confirmOverlay);
            await this.ui.confirmMsg.Async();
            this.ui.confirmMsg.SetStyles({ color: 'white', fontSize: '36px', marginBottom: '20px', fontWeight: 'bold' });

            const confirmCardsRow = panel.CreateVisualElement(this.ui.confirmOverlay);
            await confirmCardsRow.Async();
            confirmCardsRow.SetStyles({ 
                display: 'flex', 
                flexDirection: 'row', 
                gap: '25px', 
                marginBottom: '30px',
                justifyContent: 'center',
                alignItems: 'center',
                width: '100%',
                backgroundColor: 'rgba(0,0,0,0)'
            });
            
            this.ui.confirmCardSlots = [];
            for (let i = 0; i < MAX_SUPPORTED_RESPONSES; i++) {
                const cardContainer = panel.CreateVisualElement(confirmCardsRow);
                await cardContainer.Async();
                cardContainer.SetStyles({
                    display: 'none',
                    width: '250px',
                    height: '320px',
                    backgroundColor: 'white',
                    padding: '20px',
                    borderRadius: '15px',
                    borderWidth: '4px',
                    borderColor: '#666666',
                    flexDirection: 'column',
                    alignItems: 'flex-start'
                });

                const cardLabel = panel.CreateLabel(undefined, cardContainer);
                await cardLabel.Async();
                cardLabel.SetStyles({
                    width: '100%',
                    height: '100%',
                    color: 'black',
                    fontSize: '16px',
                    fontWeight: 'bold',
                    textAlign: 'upper-left'
                });

                this.ui.confirmCardSlots.push({ container: cardContainer, label: cardLabel });
            }

            const confirmBtns = panel.CreateVisualElement(this.ui.confirmOverlay);
            await confirmBtns.Async();
            confirmBtns.SetStyles({ 
                display: 'flex', 
                flexDirection: 'row', 
                gap: '30px',
                backgroundColor: 'rgba(0,0,0,0)' 
            });

            await createBtn(confirmBtns, "CANCEL", "#F44336", () => {
                this.isConfirmationDialogOpen = false;
                this.ui.confirmOverlay.SetStyles({ display: 'none' });
            });
            await createBtn(confirmBtns, "CONFIRM", "#4CAF50", () => {
                if (this.confirmCallback) this.confirmCallback();
                this.isConfirmationDialogOpen = false;
                this.ui.confirmOverlay.SetStyles({ display: 'none' });
            });
            
            await this.buildDeckOptionsUI(panel, rootEl, createBtn);
        }

        async buildDeckOptionsUI(panel, rootEl, createBtn) {
            this.ui.deckOptionsOverlay = panel.CreateVisualElement(rootEl);
            await this.ui.deckOptionsOverlay.Async();
            this.ui.deckOptionsOverlay.SetStyles({
                display: 'none', position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
                backgroundColor: 'rgba(10, 10, 10, 0.98)', flexDirection: 'column', alignItems: 'center',
                paddingTop: '40px', zIndex: '90'
            });

            const title = panel.CreateLabel(undefined, this.ui.deckOptionsOverlay);
            await title.Async();
            title.text = "SELECT DECKS";
            title.SetStyles({ backgroundColor: 'rgba(0,0,0,0)', color: 'white', fontSize: '36px', marginBottom: '20px', fontWeight: 'bold' });

            const scrollArea = panel.CreateScrollView(this.ui.deckOptionsOverlay);
            await scrollArea.Async();
            scrollArea.SetStyles({
                width: '850px', height: '650px', backgroundColor: 'rgba(0,0,0,0.9)',
                overflow: 'scroll', marginBottom: '20px'
            });
            
            if (scrollArea.parent && scrollArea.parent.SetStyles) {
                scrollArea.parent.SetStyles({ backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' });
            }

            const packsGrid = panel.CreateVisualElement(scrollArea);
            await packsGrid.Async();
            packsGrid.SetStyles({
                display: 'flex', flexWrap: 'wrap', flexDirection: 'row', justifyContent: 'center',
                width: '100%', backgroundColor: 'rgba(0,0,0,0)'
            });

            this.ui.packButtons = [];
            
            const MAX_PACKS = 500;
            for (let i = 0; i < MAX_PACKS; i++) {
                const btn = panel.CreateButton(packsGrid);
                await btn.Async();
                
                btn.SetStyles({
                    display: 'none', backgroundColor: '#333333', color: 'white',
                    width: '240px', height: '90px', margin: '8px', borderRadius: '10px',
                    fontSize: '18px', borderWidth: '4px', borderColor: '#aaaaaa'
                });
                
                btn.OnClick(() => {
                    const pack = this.availablePacks?.[i];
                    if (!pack) return;
                    const packId = pack.id;
                    if (this.tempSelectedPacks.includes(packId)) {
                        if (this.tempSelectedPacks.length > 1) {
                            this.tempSelectedPacks = this.tempSelectedPacks.filter(id => id !== packId);
                        }
                    } else {
                        this.tempSelectedPacks.push(packId);
                    }
                    this.updateDeckOptionsUI();
                });
                
                this.ui.packButtons.push(btn);
            }

            const btnsRow = panel.CreateVisualElement(this.ui.deckOptionsOverlay);
            await btnsRow.Async();
            btnsRow.SetStyles({ display: 'flex', flexDirection: 'row', gap: '30px', backgroundColor: 'rgba(0,0,0,0)' });

            await createBtn(btnsRow, "CANCEL", "#F44336", () => {
                this.closeDeckOptionsUI();
            });
            await createBtn(btnsRow, "SAVE DECKS", "#4CAF50", () => {
                this.sendAction("update-decks", this.tempSelectedPacks);
                this.closeDeckOptionsUI();
            });
        }

        openDeckOptionsUI() {
            this.tempSelectedPacks = [...(this.gameState.selectedPacks && this.gameState.selectedPacks.length > 0 ? this.gameState.selectedPacks : this.defaultSelectedPacks)];
            this.updateDeckOptionsUI();
            this.ui.deckOptionsOverlay.SetStyles({ display: 'flex' });
            this._isDeckOptionsOpen = true;
        }

        closeDeckOptionsUI() {
            this.ui.deckOptionsOverlay.SetStyles({ display: 'none' });
            this._isDeckOptionsOpen = false;
        }

        updateDeckOptionsUI() {
            if (!this.availablePacks) return;
            
            // Hide all buttons first
            this.ui.packButtons.forEach(btn => btn.SetStyles({ display: 'none' }));

            this.availablePacks.forEach((pack, index) => {
                const btn = this.ui.packButtons[index];
                if (btn) {
                    btn.text = this.wrapText(pack.name, 22);
                    const isSelected = this.tempSelectedPacks.includes(pack.id);
                    btn.SetStyles({
                        display: 'flex',
                        backgroundColor: isSelected ? '#4CAF50' : '#333333',
                        borderColor: isSelected ? '#ffffff' : '#aaaaaa'
                    });
                }
            });
        }

        confirm(message, callback, previewCards = null) {
            this.ui.confirmMsg.text = message;
            this.confirmCallback = callback;
            this.isConfirmationDialogOpen = true;
            this.ui.confirmOverlay.SetStyles({ display: 'flex', backgroundColor: 'rgba(10, 10, 10, 0.98)' });

            // Determine which cards to show in the preview slots
            let cardsToShow = previewCards;
            if (!cardsToShow && this.selectedCardIds.length > 0) {
                const localPlayer = this.gameState?.players?.[scene.localUser.uid];
                if (localPlayer) {
                    cardsToShow = this.selectedCardIds.map(id => localPlayer.cards.find(c => c && c._id === id)).filter(Boolean);
                }
            }

            if (cardsToShow && cardsToShow.length > 0) {
                this.ui.confirmCardSlots.forEach((slot, idx) => {
                    if (idx < cardsToShow.length) {
                        slot.label.text = this.wrapText(cardsToShow[idx].text, 19);
                        slot.container.SetStyles({ display: 'flex' });
                    } else {
                        slot.container.SetStyles({ display: 'none' });
                    }
                });
            } else {
                this.ui.confirmCardSlots.forEach(slot => slot.container.SetStyles({ display: 'none' }));
            }
        }

        triggerSound(state, name) { // Renamed from playSound
            state._triggerSound = name;
        }

        onCardClick(index) {
            if (!this.gameState || this.isConfirmationDialogOpen) return;
            const localPlayer = this.gameState.players[scene.localUser.uid];
            if (!localPlayer || !localPlayer.cards) return;
            const card = localPlayer.cards[index];
            if (!card) return;
            const numReq = this.gameState.currentBlackCard?.numResponses || 1;

            if (this.selectedCardIds.includes(card._id)) {
                this.selectedCardIds = this.selectedCardIds.filter(id => id !== card._id);
            } else if (this.selectedCardIds.length < numReq) {
                this.selectedCardIds.push(card._id);
            }
            this.updateUI();
        }

        updateUI() {
            if (!this.gameState || !this.gameState.players || !scene.localUser) return;
            const players = this.gameState.players;
            const localUid = scene.localUser.uid;
            const isPlaying = !!players[localUid];
            const isCzar = this.gameState.czar === localUid;
            const isHost = this.isHost();

            // Auto-close deck options if we are no longer the host
            if (!isHost && this._isDeckOptionsOpen) {
                this.closeDeckOptionsUI();
            }

            // Update Central Hub
            this.ui.joinBtn.SetStyles({ display: isPlaying ? 'none' : 'flex' });
            this.ui.leaveBtn.SetStyles({ display: isPlaying ? 'flex' : 'none' });
            this.ui.creditLabel.SetStyles({ display: isPlaying ? 'none' : 'flex' });
            this.ui.claimHostBtn.SetStyles({ display: isHost ? 'none' : 'flex' });

            const numPlayers = Object.keys(players).length;
            const minPlayers = 3;
            
            if (!this.gameState.isStarted) {
                if (numPlayers < minPlayers) {
                    this.ui.statusLabel.text = `Waiting for players... (${numPlayers}/${minPlayers} joined) ${MAX_PLAYERS} Max`;
                    this.ui.statusLabel.SetStyles({ display: 'flex' });
                    this.ui.dealBtn.SetStyles({ display: 'none' });
                    this.ui.deckOptionsBtn.SetStyles({ display: isHost ? 'flex' : 'none' });
                } else {
                    this.ui.statusLabel.SetStyles({ display: 'none' });
                    this.ui.dealBtn.SetStyles({ display: isHost ? 'flex' : 'none' });
                    this.ui.deckOptionsBtn.SetStyles({ display: isHost ? 'flex' : 'none' });
                }
            } else {
                this.ui.statusLabel.SetStyles({ display: 'none' });
                this.ui.dealBtn.SetStyles({ display: 'none' });
                this.ui.deckOptionsBtn.SetStyles({ display: 'none' });
            }

            if (this.gameState.isStarted && this.gameState.currentBlackCard) {
                const canSeeBlack = isCzar || this.gameState.showBlack;
                if (canSeeBlack) {
                    let cardText = this.gameState.currentBlackCard.text;
                    let wrapped = this.wrapText(cardText, 30);
                    if (isCzar && !this.gameState.showBlack) {
                        wrapped += "\n\n<color=yellow>(CLICK TO REVEAL)</color>";
                    }
                    this.ui.blackCard.label.text = wrapped;
                    this.ui.blackCard.container.SetStyles({ display: 'flex' });
                } else {
                    this.ui.blackCard.label.text = "WAITING FOR CZAR\nTO REVEAL CARD...";
                    this.ui.blackCard.container.SetStyles({ display: 'flex' });
                }
            } else {
                this.ui.blackCard.container.SetStyles({ display: 'none' });
            }

            // Czar Display updates
            const responders = Object.values(players).filter(p => p._id !== this.gameState.czar);
            const numReq = this.gameState.currentBlackCard?.numResponses || 1;

            // Only show responses if round is over (winner selected) or if everyone has submitted
            const activeResponders = responders.filter(p => (p.cards && p.cards.length > 0) || (p.selected && p.selected.length > 0));
            const allSubmitted = activeResponders.length > 0 && activeResponders.every(p => p.selected && p.selected.length >= numReq);
            
            if (this.gameState.winner) {
                const winnerId = (this.gameState.winner && typeof this.gameState.winner === 'object') ? this.gameState.winner._id : this.gameState.winner;
                const winnerPlayer = Object.values(players).find(p => p._id === winnerId);
                this.ui.winnerLabel.text = `WINNER: ${winnerPlayer?.name || "???"}`;
                this.ui.winnerLabel.SetStyles({ display: 'flex' });
                this.ui.czarResponsesRow.SetStyles({ display: 'flex' });
                this.ui.czarControlsRow.SetStyles({ display: 'none' });

                this.ui.czarResponseCards.forEach((slot, idx) => {
                    if (idx < numReq) {
                        slot.label.text = this.wrapText(winnerPlayer?.selected?.[idx]?.text || "", 19);
                        slot.container.SetStyles({ display: 'flex' });
                    } else {
                        slot.container.SetStyles({ display: 'none' });
                    }
                });
            } else if (this.gameState.isStarted && allSubmitted) {
                this.ui.winnerLabel.SetStyles({ display: 'none' });
                this.ui.czarResponsesRow.SetStyles({ display: 'flex' });
                this.ui.czarControlsRow.SetStyles({ display: isCzar ? 'flex' : 'none' });

                const responses = responders
                    .filter(p => p.selected && p.selected.length > 0)
                    .sort((a, b) => a._id.localeCompare(b._id));
                    
                const currentIdx = this.gameState.currentPreviewResponse || 0;
                const activeResponse = responses[currentIdx];

                // Highlight Prev/Next buttons if there's more to scroll
                if (isCzar) {
                    this.ui.czarPrevBtn.SetStyles({ backgroundColor: currentIdx > 0 ? "#4CAF50" : "#555" });
                    this.ui.czarNextBtn.SetStyles({ backgroundColor: currentIdx < (responses.length - 1) ? "#4CAF50" : "#555" });
                }

                this.ui.czarResponseCards.forEach((slot, idx) => {
                    if (idx < numReq) {
                        slot.label.text = this.wrapText(activeResponse?.selected?.[idx]?.text || "", 19);
                        slot.container.SetStyles({ display: 'flex' });
                    } else {
                        slot.container.SetStyles({ display: 'none' });
                    }
                });
            } else {
                this.ui.winnerLabel.SetStyles({ display: 'none' });
                this.ui.czarResponsesRow.SetStyles({ display: 'none' });
                this.ui.czarControlsRow.SetStyles({ display: 'none' });
            }

            // Update Slices
            for (let i = 0; i < MAX_PLAYERS; i++) {
                const slice = this.ui.slices[i];
                if (!slice) continue;
                const playerAtPos = Object.values(players).find(p => p.position === i);

                if (!playerAtPos) {
                    slice.nameText.text = "Empty Seat";
                    slice.statusText.text = "";
                    slice.timerText.text = "";
                    slice.sRoot.SetStyles({ display: 'none' });
                    // Scale down the hand GameObject entirely if no player is at this slice
                    slice.handObj.transform.localScale = new BS.Vector3(0, 0, 0);
                    if (slice.wedgeMat) slice.wedgeMat.color = new BS.Vector4(0.15, 0.15, 0.15, 1);
                    continue;
                }

                slice.sRoot.SetStyles({ display: 'flex', backgroundColor: 'rgba(20, 20, 20, 0.93)' });
                slice.nameText.text = playerAtPos.name + ` (${playerAtPos.trophies || 0}🏆)`;
                
                // Inactivity & Disconnect Timer Display
                const kickTime = playerAtPos.inactivityKickTime || 0;
                const discTime = playerAtPos.disconnectTime || 0; // Use disconnectTime from player object
                const now = new Date().getTime();
                
                let timerStr = "";
                let secondsLeft = Infinity;
                let icon = "⏱️";

                if (kickTime > 0) {
                    secondsLeft = Math.max(0, Math.floor((kickTime - now) / 1000));
                }

                if (discTime > 0 && !playerAtPos.connected) { // Only show disconnect timer if actually disconnected
                    const discSeconds = Math.max(0, Math.floor((discTime + (DISCONNECT_TIMEOUT_SECONDS * 1000) - now) / 1000));
                    if (discSeconds < secondsLeft) {
                        secondsLeft = discSeconds;
                        icon = "📡";
                    }
                }

                if (secondsLeft !== Infinity && secondsLeft > 0 && secondsLeft < 300) {
                    timerStr = `${icon} ${secondsLeft}s`;
                }
                slice.timerText.text = timerStr;

                const sliceIsCzar = this.gameState.czar === playerAtPos._id;
                const isLocalUser = playerAtPos._id === localUid;
                
                if (sliceIsCzar) {
                    slice.wedgeMat.color = new BS.Vector4(0.2, 0.6, 1.0, 1); // Vibrant Blue for Czar
                } else if (isLocalUser) {
                    slice.wedgeMat.color = new BS.Vector4(0.4, 1.0, 0.4, 1); // Vibrant Green for Local
                } else {
                    slice.wedgeMat.color = new BS.Vector4(0.3, 0.3, 0.3, 1); // Lighter Grey for Others
                }

                if (isLocalUser) {
                    const hasCards = playerAtPos.cards && playerAtPos.cards.length > 0;
                    const showHand = this.gameState.isStarted && !sliceIsCzar && !this.gameState.winner && hasCards && (!playerAtPos.selected || !playerAtPos.selected.length);
                    
                    // Scale the hand GameObject based on showHand status
                    slice.handObj.transform.localScale = showHand ? new BS.Vector3(0.08, 0.08, 0.08) : new BS.Vector3(0, 0, 0);

                    if (showHand) {
                        slice.hRoot.SetStyles({ display: 'flex' });
                        slice.statusText.text = "PICK CARDS";
                        
                        // Update selection counter
                        const numSelected = this.selectedCardIds.length;
                        slice.selectionLabel.text = `${numSelected} / ${numReq} Selected`;
                        slice.selectionLabel.SetStyles({ color: numSelected === numReq ? '#4CAF50' : 'white' });

                        playerAtPos.cards.forEach((card, idx) => {
                            const cardUI = slice.cardUIs[idx];
                            if (cardUI && card) {
                                const isSelected = this.selectedCardIds.includes(card._id);
                                cardUI.label.text = this.wrapText(card.text, 19);
                                cardUI.container.SetStyles({ 
                                    display: 'flex',
                                    borderColor: isSelected ? '#4CAF50' : '#aaaaaa',
                                    borderWidth: isSelected ? '6px' : '3px',
                                    opacity: isSelected ? '0.8' : '1'
                                });
                            } else if (cardUI) {
                                cardUI.container.SetStyles({ display: 'none' });
                            }
                        });

                        slice.resetBtn.SetStyles({ display: this.selectedCardIds.length > 0 ? 'flex' : 'none' });
                        
                        const canSubmit = this.selectedCardIds.length === numReq;
                        slice.submitBtn.text = this._isSubmitting ? "..." : "SUBMIT";
                        slice.submitBtn.SetStyles({ 
                            display: canSubmit ? 'flex' : 'none',
                            opacity: this._isSubmitting ? '0.5' : '1'
                        });

                        slice.dumpBtn.SetStyles({ display: !playerAtPos.hasRequestedHandDumpThisRound ? 'flex' : 'none' });
                    } else {
                        slice.hRoot.SetStyles({ display: 'none' });
                        slice.statusText.text = sliceIsCzar ? "CZAR" : (playerAtPos.selected && playerAtPos.selected.length ? "READY" : "WAITING");
                    }
                } else {
                    // For non-local users, always scale down the hand GameObject
                    slice.handObj.transform.localScale = new BS.Vector3(0, 0, 0);
                    slice.hRoot.SetStyles({ display: 'none' });
                    slice.statusText.text = sliceIsCzar ? "CZAR" : (playerAtPos.selected && playerAtPos.selected.length ? "READY" : "THINKING");
                }
            }
        }

        tickTimers() {
            // Deprecated, logic moved to tick()
        }
    }

    const game = new BullshcriptGame();
    
    if (window.BS) {
        game.init();
    } else {
        window.addEventListener("bs-loaded", () => game.init());
    }

})();