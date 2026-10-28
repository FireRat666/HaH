(function () {
    let scene;
    let currentScript = document.currentScript;

    const DOMAIN = "https://hah.firer.at/";
    const MAX_PLAYERS = 10;
    const MAX_HAND_CARDS = 12;
    const MAX_SUPPORTED_RESPONSES = 3;
    // Removed: let STATE_KEY = "hah_game";
    const IDLE_TIMEOUT_SECONDS = 90;
    const DISCONNECT_TIMEOUT_SECONDS = 45;

    // --- Hearing distance ---
    // Sounds fade with the local player's distance from the game: full volume within `near` metres,
    // silent from `far` metres, so people elsewhere in the world aren't disturbed. The head position
    // comes from an empty object attached to the player's head (Unity reports where it is), or from
    // pose-update until that works. All the games on a page share one tracker.
    function headTracker() {
        if (window.BanterGamesHead) return window.BanterGamesHead;
        const head = window.BanterGamesHead = { marker: null, attaching: false, markerPos: null, posePos: null };
        const scene = BS.BanterScene.GetInstance();
        scene.On('pose-update', e => {
            const h = e && e.detail && e.detail.head;
            if (h && h.position) head.posePos = h.position;
        });
        const attach = async () => {
            const uid = scene.localUser && scene.localUser.uid;
            if (!uid || head.marker || head.attaching) return;
            head.attaching = true;
            try {
                const go = await new BS.GameObject("GameSoundsHead").Async();
                head.marker = go;
                if (typeof BS.AttachedObject === 'function') {
                    const point = BS.AvatarBoneName ? BS.AvatarBoneName.HEAD : 0;
                    const attached = await go.AddComponent(new BS.AttachedObject({ uid, avatarAttachmentPoint: point }));
                    await attached.Attach(uid);
                } else if (typeof scene.LegacyAttachObject === 'function' && BS.LegacyAttachmentPosition) {
                    await scene.LegacyAttachObject(go, uid, BS.LegacyAttachmentPosition.HEAD);
                } else {
                    return; // no way to attach here: pose-update only
                }
                const PN = BS.PN || BS.PropertyName;
                if (typeof go.WatchTransform === 'function' && PN) {
                    await go.WatchTransform([PN.position], t => {
                        if (head.marker === go && t && t.position) head.markerPos = t.position;
                    });
                }
            } finally {
                head.attaching = false;
            }
        };
        const tryAttach = () => attach().catch(e => console.warn("Game sounds: could not follow the head", e));
        // The SDK drops attachments when the player leaves, so the marker is made again when they
        // come back (a moment later, so the SDK is ready).
        scene.On('user-left', e => {
            if (!(e && e.detail && e.detail.isLocal)) return;
            try { if (head.marker) head.marker.Destroy(); } catch (err) { }
            head.marker = null;
            head.markerPos = null;
        });
        scene.On('user-joined', e => {
            if (e && e.detail && e.detail.isLocal && !head.marker) setTimeout(tryAttach, 5000);
        });
        (async () => {
            while (!scene.localUser || scene.localUser.uid === undefined) await new Promise(r => setTimeout(r, 500));
            await tryAttach();
        })();
        return head;
    }

    // 0-1: how loud a sound from `centre` (a world position) is for the local player.
    function distanceGain(centre, near, far) {
        const head = headTracker();
        const p = head.markerPos || head.posePos;
        if (!p || !centre) return 1; // not known yet, so play it
        const d = Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z);
        if (d <= near) return 1;
        if (!(far > near) || d >= far) return 0;
        const f = 1 - (d - near) / (far - near);
        return f * f;
    }

    class CAHDeck {
        _hydrateCompact(json) {
            let packs = [];
            let sourcePacks = Array.isArray(json.packs) ? json.packs
                : json.packs ? Object.values(json.packs)
                : json.metadata ? Object.values(json.metadata)
                : [];
            for (let pack of sourcePacks) {
            pack.white = pack.white.map((index) =>
                Object.assign(
                {},
                { text: json.white[index], _id: `w${index}` },
                { pack: packs.length },
                pack.icon ? { icon: pack.icon } : {}
                )
            );
            pack.black = pack.black.map((index) =>
                Object.assign(
                {},
                typeof json.black[index] === 'string' ? { text: json.black[index] } : json.black[index],
                { _id: `b${index}`, numResponses: (typeof json.black[index] === 'object' && json.black[index].pick) || 1 },
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
            this.cardsById = new Map();
            for (const pack of this.deck) {
                for (const card of pack.white) this.cardsById.set(card._id, card);
                for (const card of pack.black) this.cardsById.set(card._id, card);
            }
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
            for (let { name, official, description, icon, white, black, sheetName } of this.deck) {
            let pack = {
                id,
                name,
                official,
                description,
                sheetName,
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

        card(id) {
            return (this.cardsById && this.cardsById.get(id)) || { _id: id, text: "?", numResponses: 1 };
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

    // Space state values are capped (16 KB in the SideQuest/Altspace SDK), so the shared state never
    // holds card text: cards are stored as their ids ("w123" / "b45") and looked up in the deck every
    // client has loaded. The draw piles aren't stored either, only a shuffle seed and how far into it
    // we are (see drawWhiteCard).
    const CARD_ID = /^[wb]\d+$/;
    const packCards = (value) => {
        if (Array.isArray(value)) return value.map(packCards);
        if (value && typeof value === 'object') {
            if (typeof value._id === 'string' && CARD_ID.test(value._id)) return value._id;
            const out = {};
            for (const k in value) out[k] = packCards(value[k]);
            return out;
        }
        return value;
    };
    const OLD_PILES = ['whiteDeck', 'blackDeck', 'whiteDiscard', 'blackDiscard'];

    // Seeded shuffle, so every client derives the same draw order from the same seed.
    const shuffled = (items, seed) => {
        const out = items.slice();
        let s = seed >>> 0;
        const rand = () => {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    };
    const newSeed = () => Math.floor(Math.random() * 4294967296);

    // --- Deck picker layout ---
    // Sections of the deck picker, in the order they are shown. Each lists the
    // sheet names from the deck data that go in it; sheets not listed here land
    // in an "Other" section at the end of their official / unofficial block.
    const PACK_GROUPS = [
        { title: 'Main Deck', official: true, sheets: ['CAH Main Deck'] },
        { title: 'Box Expansions', official: true, sheets: ['CAH Expansions'] },
        { title: 'Themed Packs', official: true, sheets: ['CAH Packs'] },
        { title: 'Standalone Sets', official: true, sheets: ['CAH Bōks cards', 'CAH Card Lab', 'CAH Clams Aclamst Huclamity', 'CAH Explains the Joke', 'CAH Out of Line', 'CAH Twists: Shit List'] },
        { title: 'Family Edition', official: true, sheets: ['CAH Family Edition'] },
        { title: 'Limited Releases', official: true, sheets: ['CAH Limited Release'] },
        { title: 'Bundles, Kits & Picture Packs', official: true, sheets: ['CAH A Few Extra', 'CAH Conversion Kits', 'CAH Image Packs'] },
        { title: 'PAX Promo Cards', official: true, sheets: ['CAH PAX Cards'] },
        { title: 'Discontinued Expansions', official: true, sheets: ['CAH Discontinued Expansions'] },
        { title: 'Discontinued Packs', official: true, sheets: ['CAH Discontinued Packs'] },
        { title: 'Standalone Games', official: false, sheets: ['Stand Alone Games'] },
        { title: 'Third Party Commercial', official: false, sheets: ['Third Party Commercial'] },
        { title: 'Fan Expansions', official: false, sheets: ['Fan Expansions'] },
        { title: 'Etsy', official: false, sheets: ['Etsy'] },
        { title: 'Special Purpose', official: false, sheets: ['Special Purpose'] },
    ];
    const MAIN_DECK_REGIONS = ['US', 'INTL', 'UK', 'CA', 'AU'];
    const EXPANSION_ORDER = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Red', 'Blue', 'Green'];

    // Short name for a pack button: the section header already says it is CAH
    // and official, so the long "Cards Against Humanity: " prefix goes.
    const packDisplayName = (name) => {
        let n = name.replace(/^Cards Against Humanity:?\s+/, '').replace(/^CAH:\s+/, '');
        n = n.replace(/^CAH Main Deck:\s+/, '');
        if (n === 'Main Deck (All Versions)') return 'All Main Decks Combined';
        // "Nerd Bundle: A Few More Cards For You Nerds (Target Exclusive)" -> "Nerd Bundle (Target Exclusive)"
        const bundle = n.match(/^(.*?Bundle)\s*[:\-]\s*A Few[^(]*(\(.*\))?$/);
        if (bundle) n = bundle[1] + (bundle[2] ? ' ' + bundle[2] : '');
        n = n.replace(/\(Cards Against Humanity /, '(');
        return n.replace(/\s+/g, ' ').trim();
    };

    // Order within a section: main decks by region then newest first, the old
    // numbered expansions in release order, everything else alphabetically
    // with numbers compared as numbers ("Pack 2" before "Pack 10").
    const packSortKey = (pack) => {
        const main = pack.name.match(/^CAH Main Deck: (\w+) v([\d.]+)/);
        if (main) {
            const region = MAIN_DECK_REGIONS.indexOf(main[1]);
            return `0-${String(region < 0 ? 9 : region)}-${String(100 - parseFloat(main[2]) * 10).padStart(3, '0')}`;
        }
        if (/Main Deck \(All Versions\)/.test(pack.name)) return '1';
        const exp = pack.name.match(/: (\w+) (Box )?Expansion$/);
        if (exp && pack.sheetName === 'CAH Discontinued Expansions') {
            return `0-${String(EXPANSION_ORDER.indexOf(exp[1])).padStart(2, '0')}`;
        }
        return '2-' + pack.displayName;
    };

    // Groups the deck's packs into picker sections. Empty packs are left out.
    const groupPacks = (packs) => {
        const sections = PACK_GROUPS.map(g => ({ ...g, packs: [] }));
        const other = { true: { title: 'Other Official', official: true, sheets: [], packs: [] }, false: { title: 'Other', official: false, sheets: [], packs: [] } };
        for (const pack of packs) {
            if (!pack.counts || pack.counts.total === 0) continue;
            pack.displayName = packDisplayName(pack.name);
            const sheet = pack.sheetName || '';
            const section = sections.find(s => s.official === !!pack.official && s.sheets.includes(sheet)) || other[!!pack.official];
            section.packs.push(pack);
        }
        const ordered = [
            ...sections.filter(s => s.official), other.true,
            ...sections.filter(s => !s.official), other.false,
        ].filter(s => s.packs.length > 0);
        for (const s of ordered) {
            s.packs.sort((a, b) => packSortKey(a).localeCompare(packSortKey(b), undefined, { numeric: true, sensitivity: 'base' }));
        }
        return ordered;
    };

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
            this._openHandConfirmSlice = null; // player slice whose hand panel shows the confirm box
            this._localHandSlice = null; // local player's slice while their hand panel is visible (null for Czar etc.)
            this._pendingSubmission = null; // { roundKey, cards, lastTry } for this player's submit this round
            this._retryingSubmission = false;
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
                volume: parseFloat(getParam("sound-volume", "0.4")), // 0-1; 0 = no sounds
                soundNear: parseFloat(getParam("sound-near", "2.5")), // metres: full volume within this
                soundFar: parseFloat(getParam("sound-far", "10")), // metres: silent from here
                rotation: getParam("rotation", "0 0 0"),
                instance: getParam("instance", "hah_game"),
                debug: getParam("debug", "false") === "true"
            };
            if (isNaN(this.params.volume)) this.params.volume = 0.4;
            if (isNaN(this.params.soundNear)) this.params.soundNear = 2.5;
            if (isNaN(this.params.soundFar)) this.params.soundFar = 10;
            this.stateKey = this.params.instance; // Changed STATE_KEY to this.stateKey
        }

        wrapText(text, maxChars = 19) {
            if (!text) return "";
            // Replace literal \n and actual newlines with spaces, then collapse extra whitespace
            const words = text.replace(/\\n/g, ' ').replace(/\n/g, ' ').split(/\s+/).filter(word => word.length > 0);
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
            if (this.isMuted || !soundFile) return;

            // The original recordings are in Assets/; the leave sound is in Assets/sfx/ (made by
            // sound-tools/make_sounds.py).
            const soundMap = {
                "join": "playerJoin.ogg",
                "leave": "sfx/leave.ogg",
                "start": "gameStart.ogg",
                "card": "card_flick.ogg",
                "win": "fanfare with pop.ogg"
            };
            const file = soundMap[soundFile];
            if (!file) return;
            const audio = new Audio(`${DOMAIN}Assets/${encodeURI(file)}`);
            audio.crossOrigin = "anonymous";
            // Quieter the further you are from the table (see distanceGain)
            const volume = this.params.volume * distanceGain(this.parseVector3(this.params.position), this.params.soundNear, this.params.soundFar);
            if (!(volume > 0.005)) return;
            audio.volume = Math.min(1, volume);
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
            headTracker(); // start following the head for sound distance

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
                this.packSections = groupPacks(this.cahDeck.listPacks());
                this.availablePacks = this.packSections.flatMap(s => s.packs);

                // Default to the newest US main deck (the first pack shown).
                const basePack = this.availablePacks.find(p => p.name === 'CAH Main Deck: US v3.0') || this.availablePacks[0];
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
                newState = raw ? this.unpackState(raw) : null;
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
                leftPlayers: {}, // Track player positions when they leave: { userId: { position, timestamp } }
                waitingRoom: [],
                czar: null,
                currentBlackCard: null,
                currentPreviewResponse: 0,
                showBlack: false,
                whiteDraw: null, // { seed, pos, packs }
                blackDraw: null,
                isStarted: false,
                winner: null,
                round: 0,
                currentHostUid: null,
                lastAction: null,
                lastSound: null, // Add lastSound to default state
                selectedPacks: []
            };
        }

        // State as stored in the space: card ids, no draw piles.
        packState(state) {
            const out = packCards(state);
            for (const k of OLD_PILES) delete out[k];
            const json = JSON.stringify(out);
            if (json.length > 15000) this.log(`Warning: game state is ${json.length} bytes, close to the space's 16 KB limit.`);
            return json;
        }

        // State as used here: full card objects.
        unpackState(raw) {
            const state = JSON.parse(raw);
            if (!state) return state;
            const card = (c) => (typeof c === 'string' && CARD_ID.test(c) ? this.cahDeck.card(c) : c);
            const cards = (list) => (Array.isArray(list) ? list.map(card) : list);
            for (const p of Object.values(state.players || {})) {
                p.cards = cards(p.cards);
                p.selected = cards(p.selected);
            }
            if (state.winner) {
                state.winner.cards = cards(state.winner.cards);
                state.winner.selected = cards(state.winner.selected);
            }
            state.currentBlackCard = card(state.currentBlackCard);
            for (const k of OLD_PILES) delete state[k];
            return state;
        }

        async updateState(patch) {
            if (!this.gameState) return;
            Object.assign(this.gameState, patch);

            // If a sound was triggered during logic, sync it
            if (this.gameState._triggerSound) {
                this.gameState.lastSound = { file: this.gameState._triggerSound, ts: Date.now() };
                delete this.gameState._triggerSound;
            }
            
            await scene.SetPublicSpaceProps({ [this.stateKey]: this.packState(this.gameState) });
            // Do NOT call sync() here, it will overwrite our local changes with stale space data
            // until the network update actually propagates back to us.
            this.updateUI();
        }

        async sendAction(action, data = {}, senderUid = null) {
            if (!scene?.localUser || !scene?.spaceState) return false;
            
            const localUid = senderUid || scene.localUser.uid;
            const localName = scene.localUser.name;

            for (let attempt = 0; attempt < 5; attempt++) {
                const raw = scene.spaceState.public[this.stateKey];
                let state;
                try {
                    state = raw ? this.unpackState(raw) : this.getDefaultState();
                } catch (err) {
                    state = this.getDefaultState();
                }

                // Check if our action is already there (e.g. from a successful previous attempt that we thought failed)
                if (state.lastAction && state.lastAction.userId === localUid && state.lastAction.action === action && JSON.stringify(packCards(state.lastAction.data)) === JSON.stringify(packCards(data))) {
                    // Action already reflected, no need to retry
                    this.sync();
                    return true;
                }

                const updated = this.applyGameLogic(state, action, localUid, localName, data);
                if (!updated) return false;

                if (updated._triggerSound) {
                    updated.lastSound = { file: updated._triggerSound, ts: Date.now() };
                    delete updated._triggerSound;
                }
                
                const actionId = Math.random().toString(36).substring(7);
                updated.lastAction = { action, userId: localUid, data, timestamp: Date.now(), id: actionId };

                await scene.SetPublicSpaceProps({ [this.stateKey]: this.packState(updated) });
                
                // Short delay to let the space settle, then verify if our change persisted
                await new Promise(r => setTimeout(r, 200));
                const postRaw = scene.spaceState.public[this.stateKey];
                
                // If the current space state contains our unique action ID, we succeeded!
                if (postRaw && postRaw.includes(actionId)) {
                    this.gameState = updated; // Update local state immediately
                    this.updateUI();
                    return true;
                }
                
                this.log(`Action ${action} stomped or slow, retrying (attempt ${attempt + 1})...`);
                // Random jitter before retry to reduce further collisions
                await new Promise(r => setTimeout(r, 100 + Math.random() * 300));
            }
            this.log(`Failed to deliver action ${action} after 5 attempts.`);
            return false;
        }

        isHost() {
            if (!scene || !scene.localUser) return false;
            if (!this.gameState || !this.gameState.currentHostUid) {
                const uids = Object.keys(scene.users || {}).sort();
                return uids.length > 0 && uids[0] === scene.localUser.uid;
            }
            return this.gameState.currentHostUid === scene.localUser.uid;
        }

        // Identifies the current round, so a submission is never re-sent into a later round.
        roundKey(state) {
            return `${state?.round || 0}:${state?.currentBlackCard?._id || ''}`;
        }

        // Returns the local player's pending submission if it still belongs to this round and
        // hasn't shown up in the shared state yet. Clears it once it can no longer apply.
        getPendingSubmission() {
            const pending = this._pendingSubmission;
            if (!pending || !this.gameState || !scene?.localUser) return null;
            const state = this.gameState;
            const uid = scene.localUser.uid;
            const me = state.players?.[uid];
            const cardsInHand = me && pending.cards.every(c => (me.cards || []).some(h => h && h._id === c._id));
            if (!me || !state.isStarted || state.winner || state.czar === uid ||
                this.roundKey(state) !== pending.roundKey || (!(me.selected && me.selected.length) && !cardsInHand)) {
                this._pendingSubmission = null;
                return null;
            }
            if (me.selected && me.selected.length) return null; // landed; keep it in case a later write drops it
            return pending;
        }

        // Every player writes the whole game state, so two people submitting at the same moment can
        // overwrite each other, and sendAction can report success before the other write arrives.
        // This re-sends our submission while the shared state still shows us without one.
        async retryPendingSubmission() {
            if (this._isSubmitting || this._retryingSubmission) return;
            const pending = this.getPendingSubmission();
            if (!pending || Date.now() - pending.lastTry < 2500) return;
            pending.lastTry = Date.now();
            this._retryingSubmission = true;
            try {
                this.log("Submitted cards missing from game state, re-sending...");
                await this.sendAction("choose-cards", pending.cards);
            } finally {
                this._retryingSubmission = false;
                this.updateUI();
            }
        }

        async tick() {
            if (!this.gameState || !scene?.localUser) return;
            const now = Date.now();
            const localUid = scene.localUser.uid;

            this.retryPendingSubmission();

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

        // Draws the next card from the seeded order of the selected packs. When the order runs out
        // (or the packs change) it reshuffles with a new seed. Cards in someone's hand, submitted, or
        // on the table are skipped, so nobody holds a duplicate.
        drawCard(state, color) {
            const key = color === 'white' ? 'whiteDraw' : 'blackDraw';
            const selected = state.selectedPacks && state.selectedPacks.length > 0 ? state.selectedPacks : this.defaultSelectedPacks;
            const packs = [...selected].sort((a, b) => a - b).join(',');
            const pool = this.cahDeck.getPacks(selected)[color].map(c => c._id);
            if (pool.length === 0) return null;

            let draw = state[key];
            if (!draw || draw.packs !== packs) draw = state[key] = { seed: newSeed(), pos: 0, packs };

            const inUse = new Set();
            for (const p of Object.values(state.players || {})) {
                for (const c of [...(p.cards || []), ...(p.selected || [])]) if (c) inUse.add(c._id);
            }
            if (state.currentBlackCard) inUse.add(state.currentBlackCard._id);

            for (let tries = 0; tries < pool.length * 2; tries++) {
                if (draw.pos >= pool.length) {
                    draw.seed = newSeed();
                    draw.pos = 0;
                }
                const order = this._drawOrder(color, pool, draw.seed);
                const id = order[draw.pos++];
                if (!inUse.has(id)) return this.cahDeck.card(id);
            }
            return null; // every card is in use
        }

        // The shuffled order is cached per colour, as it only changes with the seed or packs.
        _drawOrder(color, pool, seed) {
            if (!this._orders) this._orders = {};
            const cacheKey = `${seed}:${pool.length}:${pool[0]}`;
            const cached = this._orders[color];
            if (cached && cached.key === cacheKey) return cached.order;
            const order = shuffled(pool, seed);
            this._orders[color] = { key: cacheKey, order };
            return order;
        }

        drawWhiteCard(state) {
            return this.drawCard(state, 'white');
        }

        drawBlackCard(state) {
            return this.drawCard(state, 'black');
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
                        this.triggerSound(state, "card");
                    }
                    break;

                case "join-game":
                    if (!player && Object.keys(players).length < MAX_PLAYERS) {
                        const occupied = new Set(Object.values(players).map(p => p.position));
                        let pos = -1;

                        // Clean up stale leftPlayers (older than 10 minutes)
                        if (state.leftPlayers) {
                            const tenMinutesAgo = Date.now() - 600000;
                            Object.keys(state.leftPlayers).forEach(uid => {
                                if (state.leftPlayers[uid].timestamp < tenMinutesAgo) {
                                    delete state.leftPlayers[uid];
                                }
                            });
                        }

                        // Check if player has a remembered position that is still vacant
                        if (state.leftPlayers && state.leftPlayers[userId]) {
                            const rememberedPos = state.leftPlayers[userId].position;
                            if (!occupied.has(rememberedPos)) {
                                pos = rememberedPos;
                            }
                            delete state.leftPlayers[userId];
                        }

                        // If no remembered position or it was occupied, choose a random available one
                        if (pos === -1) {
                            const available = [0,1,2,3,4,5,6,7,8,9].filter(p => !occupied.has(p));
                            if (available.length > 0) {
                                pos = available[Math.floor(Math.random() * available.length)];
                            }
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
                        this.triggerSound(state, "join");
                    }
                    break;

                case "leave-game":
                    if (players[userId]) {
                        const p = players[userId];
                        
                        // Save position in leftPlayers
                        if (!state.leftPlayers) state.leftPlayers = {};
                        state.leftPlayers[userId] = {
                            position: p.position,
                            timestamp: Date.now()
                        };

                        const wasCzar = state.czar === userId;
                        delete players[userId];

                        if (Object.keys(players).length < 3 || wasCzar) {
                            state.isStarted = false;
                            state.winner = null;
                            state.czar = null;
                        }
                        // Conditionally trigger sound
                        if (data.playSound !== false) { // playSound is passed in data from driveHostLogic
                            this.triggerSound(state, "leave");
                        }
                    }
                    break;

                case "start-game":
                    if (this.isHost() && (!state.isStarted || state.winner) && Object.keys(players).length >= 3) {
                        state = this.initializeNewRound(state);
                        this.triggerSound(state, "start");
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
                            // Only set inactivity timer for players who actually have cards and have not yet selected cards
                            if (p._id !== state.czar && p.cards && p.cards.length > 0 && (!p.selected || p.selected.length === 0)) {
                                p.inactivityKickTime = now + (IDLE_TIMEOUT_SECONDS * 1000);
                            } else {
                                p.inactivityKickTime = 0;
                            }
                        });

                        // If all active responders have already selected cards, set Czar timer to choose winner
                        const activeResponders = Object.values(players).filter(p => p._id !== state.czar && ((p.cards && p.cards.length > 0) || (p.selected && p.selected.length > 0)));
                        if (activeResponders.length > 0 && activeResponders.every(p => p.selected.length > 0)) {
                            if (state.players[state.czar]) {
                                state.players[state.czar].inactivityKickTime = now + (IDLE_TIMEOUT_SECONDS * 1000);
                            }
                        }

                        this.triggerSound(state, "card");
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
                            this.triggerSound(state, "card");
                        }
                    }
                    break;

                case "preview-response":
                    if (state.czar === userId) {
                        state.currentPreviewResponse = data;
                        this.triggerSound(state, "card");
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
                        this.triggerSound(state, "win");
                    }
                    break;

                case "dump-hand":
                    if (player && state.czar !== userId && !player.hasRequestedHandDumpThisRound) {
                        player.wantsNewHand = true;
                        player.hasRequestedHandDumpThisRound = true;
                        this.triggerSound(state, "card");
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
                // Removed: gap: '40px',
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
            nameText.SetStyles({ color: 'white', fontSize: '36px', fontWeight: 'bold', marginRight: '40px' });

            const statusText = sPanel.CreateLabel(undefined, sRoot);
            await statusText.Async();
            statusText.text = "";
            statusText.SetStyles({ color: '#ffcc00', fontSize: '32px', marginRight: '40px' });

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
                paddingTop: '20px',
                paddingBottom: '20px',
                paddingLeft: '20px',
                paddingRight: '20px',
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
                // Removed: gap: '20px',
                marginBottom: '20px',
                backgroundColor: 'rgba(0,0,0,0)'
            });

            const selectionLabel = hPanel.CreateLabel(undefined, actionsRow);
            await selectionLabel.Async();
            selectionLabel.text = "";
            selectionLabel.SetStyles({ color: 'white', fontSize: '28px', fontWeight: 'bold', marginRight: '20px' });

            const createBtn = async (pnl, parent, text, color, handler, marginRight = '0px') => {
                const btn = pnl.CreateButton(parent);
                await btn.Async();
                btn.text = text;
                btn.SetStyles({ backgroundColor: color, color: 'white', paddingTop: '15px', paddingBottom: '15px', paddingLeft: '30px', paddingRight: '30px', borderRadius: '12px', fontSize: '25px', borderWidth: '0px', marginRight: marginRight });
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

                // Shown on this player's own hand panel, not the central screen
                this.confirm("Submit these cards?", async () => {
                    // Remember the submission until the round ends, so it can be re-sent if
                    // another player's write overwrites it (see retryPendingSubmission).
                    this._pendingSubmission = { roundKey: this.roundKey(this.gameState), cards: cardsToSubmit, lastTry: Date.now() };
                    this._isSubmitting = true;
                    this.updateUI();
                    const success = await this.sendAction("choose-cards", cardsToSubmit);
                    this._isSubmitting = false;
                    if (success) {
                        this.selectedCardIds = [];
                    } else {
                        this.log("Card submission failed. Selection retained. Please try again.");
                    }
                    this.updateUI();
                }, undefined, this.ui.slices[index]);
            }, '20px');
            const resetBtn = await createBtn(hPanel, actionsRow, "RESET", "#FF9800", () => {
                this.selectedCardIds = [];
                this.updateUI();
            }, '20px');
            const dumpBtn = await createBtn(hPanel, actionsRow, "DUMP HAND", "#F44336", () => {
                this.confirm("Dump hand ?\nNext Round you will have new cards!", () => {
                    this.sendAction("dump-hand");
                }, null, this.ui.slices[index]);
            });

            const cardsGrid = hPanel.CreateVisualElement(hRoot);
            await cardsGrid.Async();
            cardsGrid.SetStyles({
                display: 'flex',
                flexWrap: 'wrap',
                flexDirection: 'row',
                justifyContent: 'center',
                // Removed: gap: '12px',
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
                    paddingTop: '15px',
                    paddingBottom: '15px',
                    paddingLeft: '15px',
                    paddingRight: '15px',
                    borderRadius: '12px',
                    borderWidth: '4px',
                    borderColor: '#aaaaaa',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    marginRight: '12px',
                    marginBottom: '12px'
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

            // 3. Hand Confirm box (local player's own submit confirmation).
            // Shown in place of the actions row + card grid while open.
            const handConfirmBox = hPanel.CreateVisualElement(hRoot);
            await handConfirmBox.Async();
            handConfirmBox.SetStyles({
                display: 'none',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                paddingTop: '30px',
                paddingBottom: '30px',
                backgroundColor: 'rgba(10, 10, 10, 0.98)',
                borderRadius: '20px'
            });

            const handConfirmMsg = hPanel.CreateLabel(undefined, handConfirmBox);
            await handConfirmMsg.Async();
            handConfirmMsg.SetStyles({ color: 'white', fontSize: '40px', marginBottom: '25px', fontWeight: 'bold' });

            const handConfirmCardsRow = hPanel.CreateVisualElement(handConfirmBox);
            await handConfirmCardsRow.Async();
            handConfirmCardsRow.SetStyles({
                display: 'flex',
                flexDirection: 'row',
                justifyContent: 'center',
                alignItems: 'center',
                width: '100%',
                marginBottom: '30px',
                backgroundColor: 'rgba(0,0,0,0)'
            });

            const handConfirmCardSlots = [];
            for (let i = 0; i < MAX_SUPPORTED_RESPONSES; i++) {
                const cardContainer = hPanel.CreateVisualElement(handConfirmCardsRow);
                await cardContainer.Async();
                cardContainer.SetStyles({
                    display: 'none',
                    width: '230px',
                    height: '310px',
                    backgroundColor: 'white',
                    paddingTop: '18px',
                    paddingBottom: '18px',
                    paddingLeft: '18px',
                    paddingRight: '18px',
                    borderRadius: '15px',
                    borderWidth: '4px',
                    borderColor: '#4CAF50',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    marginRight: '20px'
                });

                const cardLabel = hPanel.CreateLabel(undefined, cardContainer);
                await cardLabel.Async();
                cardLabel.SetStyles({
                    width: '100%',
                    height: '100%',
                    color: 'black',
                    fontSize: '16px',
                    fontWeight: 'bold',
                    textAlign: 'upper-left'
                });

                handConfirmCardSlots.push({ container: cardContainer, label: cardLabel });
            }

            const handConfirmBtns = hPanel.CreateVisualElement(handConfirmBox);
            await handConfirmBtns.Async();
            handConfirmBtns.SetStyles({ display: 'flex', flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0)' });

            await createBtn(hPanel, handConfirmBtns, "CANCEL", "#F44336", () => this.closeConfirm(), '30px');
            await createBtn(hPanel, handConfirmBtns, "CONFIRM", "#4CAF50", () => {
                const cb = this.confirmCallback;
                this.closeConfirm();
                if (cb) cb();
            });

            return {
                root: sliceRoot,
                wedgeMat: matNormal,
                statusObj, sRoot, nameText, statusText, timerText,
                handObj, hRoot, actionsRow, submitBtn, resetBtn, dumpBtn, selectionLabel, cardsGrid, cardUIs,
                handConfirm: { box: handConfirmBox, msg: handConfirmMsg, cardSlots: handConfirmCardSlots }
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
                paddingTop: '20px',
                paddingBottom: '20px',
                paddingLeft: '20px',
                paddingRight: '20px',
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
            buttonsRow.SetStyles({ display: 'flex', backgroundColor: 'rgba(0,0,0,0)', backgroundImage: 'none', flexDirection: 'row', /* Removed: gap: '20px', */ marginBottom: '20px', borderWidth: '0px', paddingTop: '5px', paddingBottom: '5px', paddingLeft: '5px', paddingRight: '5px', marginTop: '5px', marginBottom: '5px', marginLeft: '5px', marginRight: '5px' });

            const createBtn = async (parent, text, color, handler, marginRight = '0px') => {
                const btn = panel.CreateButton(parent);
                await btn.Async();

                if (btn.parent && btn.parent.SetStyles) {
                    btn.parent.SetStyles({ backgroundColor: 'rgba(0,0,0,0)', backgroundImage: 'none' });
                }

                btn.text = text;
                btn.SetStyles({ backgroundColor: color, color: 'white', paddingTop: '15px', paddingBottom: '15px', paddingLeft: '30px', paddingRight: '30px', borderRadius: '8px', fontSize: '24px', borderWidth: '0px', backgroundImage: 'none', margin: '8px', marginRight: marginRight });
                btn.OnClick(handler);
                return btn;
            };

            this.ui.joinBtn = await createBtn(buttonsRow, "JOIN GAME", "#2196F3", () => this.sendAction("join-game"), '20px');
            this.ui.dealBtn = await createBtn(buttonsRow, "START ROUND", "#4CAF50", () => this.sendAction("start-game"), '20px');
            this.ui.deckOptionsBtn = await createBtn(buttonsRow, "DECK OPTIONS", "#FF9800", () => this.openDeckOptionsUI(), '20px');
            this.ui.leaveBtn = await createBtn(buttonsRow, "LEAVE GAME", "#F44336", () => this.confirm("Leave game?", () => this.sendAction("leave-game"), null, this._localHandSlice), '20px');
            this.ui.claimHostBtn = await createBtn(buttonsRow, "CLAIM HOST", "#9C27B0", () => this.sendAction("claim-host"), '20px');
            this.ui.muteBtn = await createBtn(buttonsRow, "🔊", "#607D8B", () => {
                this.isMuted = !this.isMuted;
                this.ui.muteBtn.text = this.isMuted ? "🔇" : "🔊";
            });

            const creditLabel = panel.CreateLabel(undefined, rootEl);
            await creditLabel.Async();
            creditLabel.text = "Cards Against Humanity LLC\nLicensed under CC BY-NC-SA\ncardsagainsthumanity.com\nAdapted for AltspaceVR by:\nDerogatory, falkrons, schmidtec\nOriginally Ported to Banter by Shane\nSDK Port & Card Data by FireRat\nv0.9.0";
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
                paddingTop: '25px',
                paddingBottom: '25px',
                paddingLeft: '25px',
                paddingRight: '25px',
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
            czarResponsesRow.SetStyles({ display: 'none', flexDirection: 'row', /* Removed: gap: '15px', */ marginBottom: '20px', backgroundColor: 'rgba(0,0,0,0)', backgroundImage: 'none' });
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
                    paddingTop: '20px',
                    paddingBottom: '20px',
                    paddingLeft: '20px',
                    paddingRight: '20px',
                    borderRadius: '15px',
                    borderWidth: '4px',
                    borderColor: '#aaaaaa',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    marginTop: '8px',
                    marginBottom: '8px',
                    marginLeft: '8px',
                    marginRight: '15px', // Added marginRight
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
            czarControlsRow.SetStyles({ display: 'none', flexDirection: 'row', /* Removed: gap: '15px', */ backgroundColor: 'rgba(0,0,0,0)', backgroundImage: 'none' });
            this.ui.czarControlsRow = czarControlsRow;

            this.ui.czarPrevBtn = await createBtn(czarControlsRow, "PREV", "#555", () => {
                const responders = Object.values(this.gameState.players)
                    .filter(p => p._id !== this.gameState.czar && p.selected && p.selected.length > 0)
                    .sort((a, b) => a._id.localeCompare(b._id));
                const nextIdx = Math.max(0, (this.gameState.currentPreviewResponse || 0) - 1);
                this.sendAction("preview-response", nextIdx);
            }, '15px');
            this.ui.czarWinnerBtn = await createBtn(czarControlsRow, "CHOOSE WINNER", "#4CAF50", () => {
                const responders = Object.values(this.gameState.players)
                    .filter(p => p._id !== this.gameState.czar && p.selected && p.selected.length > 0)
                    .sort((a, b) => a._id.localeCompare(b._id));
                const activeResponse = responders[this.gameState.currentPreviewResponse || 0];
                if (activeResponse) {
                    this.confirm(`Crown this card(s) the winner?`, () => this.sendAction("choose-winner", activeResponse._id), activeResponse.selected);
                }
            }, '15px');
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
                // Removed: gap: '25px',
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
                    paddingTop: '20px',
                    paddingBottom: '20px',
                    paddingLeft: '20px',
                    paddingRight: '20px',
                    borderRadius: '15px',
                    borderWidth: '4px',
                    borderColor: '#666666',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    marginRight: '25px' // Added marginRight
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
                // Removed: gap: '30px',
                backgroundColor: 'rgba(0,0,0,0)'
            });

            await createBtn(confirmBtns, "CANCEL", "#F44336", () => this.closeConfirm(), '30px'); // Added marginRight
            await createBtn(confirmBtns, "CONFIRM", "#4CAF50", () => {
                const cb = this.confirmCallback;
                this.closeConfirm();
                if (cb) cb();
            });

            await this.buildDeckOptionsUI(panel, rootEl, createBtn);
        }

        async buildDeckOptionsUI(panel, rootEl, createBtn) {
            const CLEAR = 'rgba(0,0,0,0)';
            const GRID_WIDTH = '792px'; // three 250px buttons with 6px margins each side
            const clearParent = (el) => {
                if (el.parent && el.parent.SetStyles) {
                    el.parent.SetStyles({ backgroundColor: CLEAR, backgroundImage: 'none' });
                }
            };

            this.ui.deckOptionsOverlay = panel.CreateVisualElement(rootEl);
            await this.ui.deckOptionsOverlay.Async();
            this.ui.deckOptionsOverlay.SetStyles({
                display: 'none', position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
                // Opaque: any transparency lets the main screen's text show through.
                backgroundColor: '#0a0a0a', flexDirection: 'column', alignItems: 'center',
                paddingTop: '30px', zIndex: '90'
            });

            const title = panel.CreateLabel(undefined, this.ui.deckOptionsOverlay);
            await title.Async();
            title.text = "SELECT DECKS";
            title.SetStyles({ backgroundColor: CLEAR, color: 'white', fontSize: '36px', marginBottom: '6px', fontWeight: 'bold' });

            // "SCROLL FOR MORE" between two down chevrons. The UI font has no
            // arrow glyphs, so each chevron is a box with two borders, turned 45 degrees.
            const hintRow = panel.CreateVisualElement(this.ui.deckOptionsOverlay);
            await hintRow.Async();
            hintRow.SetStyles({ display: 'flex', flexDirection: 'row', alignItems: 'center', backgroundColor: CLEAR, marginBottom: '12px' });
            const chevron = async () => {
                const c = panel.CreateVisualElement(hintRow);
                await c.Async();
                c.SetStyles({
                    width: '14px', height: '14px', backgroundColor: CLEAR, rotate: '45deg',
                    borderRightWidth: '4px', borderBottomWidth: '4px', borderTopWidth: '0px', borderLeftWidth: '0px',
                    borderColor: '#00FFFF', marginLeft: '14px', marginRight: '14px', marginBottom: '6px'
                });
            };
            await chevron();
            const hint = panel.CreateLabel(undefined, hintRow);
            await hint.Async();
            hint.text = "SCROLL DOWN FOR MORE  -  TAP A SECTION TO OPEN IT";
            hint.SetStyles({ backgroundColor: CLEAR, color: '#00FFFF', fontSize: '22px', fontWeight: 'bold' });
            await chevron();

            const scrollArea = panel.CreateScrollView(this.ui.deckOptionsOverlay);
            await scrollArea.Async();
            scrollArea.SetStyles({
                width: '850px', height: '600px', backgroundColor: '#000000',
                overflow: 'scroll', marginBottom: '8px'
            });
            clearParent(scrollArea);

            const packsGrid = panel.CreateVisualElement(scrollArea);
            await packsGrid.Async();
            packsGrid.SetStyles({
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                width: '100%', backgroundColor: CLEAR, paddingBottom: '20px'
            });
            this.ui.packsGrid = packsGrid;

            this.ui.packButtons = [];
            this.ui.packSections = [];

            this.ui.deckSummary = panel.CreateLabel(undefined, this.ui.deckOptionsOverlay);
            await this.ui.deckSummary.Async();
            this.ui.deckSummary.SetStyles({ backgroundColor: CLEAR, color: '#cccccc', fontSize: '22px', marginBottom: '4px' });

            if (!this.packSections) return;

            let currentOfficial = null;
            for (const section of this.packSections) {
                // Official / unofficial block header
                if (section.official !== currentOfficial) {
                    currentOfficial = section.official;
                    const header = panel.CreateLabel(undefined, packsGrid);
                    await header.Async();
                    header.text = currentOfficial ? "OFFICIAL PACKS" : "UNOFFICIAL PACKS";
                    header.SetStyles({
                        display: 'flex', color: currentOfficial ? '#00FFFF' : '#FFD700',
                        fontSize: '32px', fontWeight: 'bold', width: GRID_WIDTH,
                        marginTop: '20px', marginBottom: '0px',
                        textAlign: 'upper-left', backgroundColor: CLEAR
                    });
                    clearParent(header);
                }

                // Section header: a full-width button that opens and closes the
                // section, so in VR you can jump between sections without long scrolls.
                const header = panel.CreateButton(packsGrid);
                await header.Async();
                header.SetStyles({
                    display: 'flex', color: '#dddddd', fontSize: '22px', fontWeight: 'bold',
                    width: GRID_WIDTH, height: '48px', marginTop: '10px', marginBottom: '4px', paddingLeft: '10px',
                    borderRadius: '8px', borderWidth: '0px', borderBottomWidth: '2px',
                    borderColor: currentOfficial ? 'rgba(0, 255, 255, 0.45)' : 'rgba(255, 215, 0, 0.45)',
                    textAlign: 'middle-left', backgroundColor: '#1b1b1b', backgroundImage: 'none'
                });
                clearParent(header);

                // Left-aligned grid so short sections line up with the full ones
                const grid = panel.CreateVisualElement(packsGrid);
                await grid.Async();
                grid.SetStyles({
                    display: 'flex', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start',
                    width: GRID_WIDTH, backgroundColor: CLEAR
                });

                const sectionUI = { section, header, grid, open: false };
                header.OnClick(() => {
                    sectionUI.open = !sectionUI.open;
                    this.updateDeckOptionsUI();
                });
                this.ui.packSections.push(sectionUI);

                for (const pack of section.packs) {
                    const btn = panel.CreateButton(grid);
                    await btn.Async();

                    // Long names drop to a smaller font so they fit the same box.
                    let name = this.wrapText(pack.displayName, 20);
                    let fontSize = '19px';
                    if (name.split('\n').length > 3) {
                        name = this.wrapText(pack.displayName, 24);
                        fontSize = '16px';
                    }
                    btn.text = `${name}\n${pack.counts.total} cards`;

                    btn.SetStyles({
                        display: 'flex', backgroundColor: '#1e1e1e', color: 'white',
                        width: '250px', height: '112px', marginTop: '6px', marginBottom: '6px', marginLeft: '6px', marginRight: '6px',
                        paddingLeft: '8px', paddingRight: '8px', borderRadius: '10px',
                        fontSize, borderWidth: '2px', borderColor: '#aaaaaa'
                    });
                    clearParent(btn);

                    btn.OnClick(() => {
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

                    this.ui.packButtons.push({ btn, pack });
                }
            }

            const btnsRow = panel.CreateVisualElement(this.ui.deckOptionsOverlay);
            await btnsRow.Async();
            btnsRow.SetStyles({ display: 'flex', flexDirection: 'row', /* Removed: gap: '30px', */ backgroundColor: 'rgba(0,0,0,0)' });

            await createBtn(btnsRow, "CANCEL", "#F44336", () => {
                this.closeDeckOptionsUI();
            }, '30px'); // Added marginRight
            await createBtn(btnsRow, "SAVE DECKS", "#4CAF50", () => {
                this.sendAction("update-decks", this.tempSelectedPacks);
                this.closeDeckOptionsUI();
            });
        }

        openDeckOptionsUI() {
            this.tempSelectedPacks = [...(this.gameState.selectedPacks && this.gameState.selectedPacks.length > 0 ? this.gameState.selectedPacks : this.defaultSelectedPacks)];
            // Start with the main decks and any section holding a chosen pack open.
            (this.ui.packSections || []).forEach((s, i) => {
                s.open = i === 0 || s.section.packs.some(p => this.tempSelectedPacks.includes(p.id));
            });
            this.updateDeckOptionsUI();
            this.ui.deckOptionsOverlay.SetStyles({ display: 'flex' });
            this._isDeckOptionsOpen = true;
        }

        closeDeckOptionsUI() {
            this.ui.deckOptionsOverlay.SetStyles({ display: 'none' });
            this._isDeckOptionsOpen = false;
        }

        updateDeckOptionsUI() {
            if (!this.ui.packButtons) return;

            if (this.ui.deckSummary) {
                const chosen = this.ui.packButtons.filter(({ pack }) => this.tempSelectedPacks.includes(pack.id));
                const cards = chosen.reduce((sum, { pack }) => sum + pack.counts.total, 0);
                this.ui.deckSummary.text = `${chosen.length} ${chosen.length === 1 ? 'pack' : 'packs'} selected  (${cards.toLocaleString('en-US')} cards)`;
            }

            (this.ui.packSections || []).forEach(({ section, header, grid, open }) => {
                const picked = section.packs.filter(p => this.tempSelectedPacks.includes(p.id)).length;
                header.text = `${open ? '-' : '+'}   ${section.title.toUpperCase()}  (${section.packs.length})${picked ? `     ${picked} selected` : ''}`;
                header.SetStyles({ color: picked ? (section.official ? '#00FFFF' : '#FFD700') : '#dddddd' });
                grid.SetStyles({ display: open ? 'flex' : 'none' });
            });

            this.ui.packButtons.forEach(({ btn, pack }) => {
                const isSelected = this.tempSelectedPacks.includes(pack.id);

                let borderColor = isSelected ? '#ffffff' : '#aaaaaa';
                let backgroundColor = isSelected ? '#43a047' : '#1e1e1e';

                if (pack.official) {
                    borderColor = isSelected ? '#00FFFF' : '#008080';
                } else {
                    borderColor = isSelected ? '#FFD700' : '#B8860B';
                }

                btn.SetStyles({
                    backgroundColor: backgroundColor,
                    borderColor: borderColor,
                    borderWidth: isSelected ? '4px' : '2px'
                });
            });
        }

        // Opens a confirm dialog. By default it shows on the central screen (used by the Czar,
        // and by Leave Game when the player has no hand panel up). Pass a player slice as
        // `slice` to show it on that player's own hand panel instead (Submit, Dump Hand, and
        // Leave Game while the hand is visible).
        confirm(message, callback, previewCards, slice = null) { // Removed default null
            this.closeConfirm();
            this.confirmCallback = callback;
            this.isConfirmationDialogOpen = true;

            let msgLabel, cardSlots;
            if (slice && slice.handConfirm) {
                this._openHandConfirmSlice = slice;
                msgLabel = slice.handConfirm.msg;
                cardSlots = slice.handConfirm.cardSlots;
                slice.actionsRow.SetStyles({ display: 'none' });
                slice.cardsGrid.SetStyles({ display: 'none' });
                slice.handConfirm.box.SetStyles({ display: 'flex' });
            } else {
                msgLabel = this.ui.confirmMsg;
                cardSlots = this.ui.confirmCardSlots;
                this.ui.confirmOverlay.SetStyles({ display: 'flex', backgroundColor: 'rgba(10, 10, 10, 0.98)' });
            }
            msgLabel.text = message;

            // Determine which cards to show in the preview slots
            let cardsToDisplay = [];
            if (previewCards !== undefined) { // Check if explicitly provided
                cardsToDisplay = previewCards;
            } else if (this.selectedCardIds.length > 0) {
                const localPlayer = this.gameState?.players?.[scene.localUser.uid];
                if (localPlayer) {
                    cardsToDisplay = this.selectedCardIds.map(id => localPlayer.cards.find(c => c && c._id === id)).filter(Boolean);
                }
            }

            if (cardsToDisplay && cardsToDisplay.length > 0) {
                cardSlots.forEach((slot, idx) => {
                    if (idx < cardsToDisplay.length) {
                        slot.label.text = this.wrapText(cardsToDisplay[idx].text, 19);
                        slot.container.SetStyles({ display: 'flex' });
                    } else {
                        slot.container.SetStyles({ display: 'none' });
                    }
                });
            } else {
                cardSlots.forEach(slot => slot.container.SetStyles({ display: 'none' }));
            }
        }

        // Hides whichever confirm dialog is open (central overlay or a hand panel's box).
        closeConfirm() {
            this.isConfirmationDialogOpen = false;
            this.confirmCallback = null;
            if (this.ui.confirmOverlay) this.ui.confirmOverlay.SetStyles({ display: 'none' });
            const slice = this._openHandConfirmSlice;
            if (slice) {
                this._openHandConfirmSlice = null;
                slice.handConfirm.box.SetStyles({ display: 'none' });
                slice.actionsRow.SetStyles({ display: 'flex' });
                slice.cardsGrid.SetStyles({ display: 'flex' });
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
                    let cardText = (this.gameState.currentBlackCard.text || "").replace(/_/g, "_____");
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
            this._localHandSlice = null;
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
                    if (this._openHandConfirmSlice === slice) this.closeConfirm();
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
                    // A submission still being re-sent counts as submitted, so the hand doesn't pop back up.
                    const pendingSubmit = !!this.getPendingSubmission();
                    const showHand = this.gameState.isStarted && !sliceIsCzar && !this.gameState.winner && hasCards && (!playerAtPos.selected || !playerAtPos.selected.length) && !pendingSubmit;
                    
                    // Scale the hand GameObject based on showHand status
                    slice.handObj.transform.localScale = showHand ? new BS.Vector3(0.08, 0.08, 0.08) : new BS.Vector3(0, 0, 0);

                    if (showHand) {
                        this._localHandSlice = slice;
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
                        if (this._openHandConfirmSlice === slice) this.closeConfirm();
                        slice.hRoot.SetStyles({ display: 'none' });
                        slice.statusText.text = sliceIsCzar ? "CZAR" : (playerAtPos.selected && playerAtPos.selected.length ? "READY" : (pendingSubmit ? "SUBMITTING..." : "WAITING"));
                    }
                } else {
                    // For non-local users, always scale down the hand GameObject
                    if (this._openHandConfirmSlice === slice) this.closeConfirm();
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