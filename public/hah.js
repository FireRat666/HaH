(function () {
    let scene;
    let currentScript = document.currentScript;

    const WEBSOCKET_URL = "wss://hah.firer.at/";
    const MAX_PLAYERS = 10;
    const MAX_HAND_CARDS = 12;
    const MAX_SUPPORTED_RESPONSES = 3;

    class BullshcriptGame {
        constructor() {
            this.ws = null;
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
                instance: getParam("instance", "demo-game"),
                deck: getParam("deck", "main"),
                debug: getParam("debug", "false") === "true",
                oneForEachInstance: getParam("one-for-each-instance", "false") === "true"
            };
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

        async init() {
            if (scene) return;
            scene = BS.BanterScene.GetInstance();
            
            if (this.params.oneForEachInstance && scene.localUser?.instance) {
                this.params.instance += scene.localUser.instance;
            }

            this.log("Initializing Banter Native Rewrite...");
            await this.buildEnvironment();

            if (!scene.unityLoaded) {
                await new Promise(resolve => {
                    scene.On("unity-loaded", resolve);
                    window.addEventListener("unity-loaded", resolve, { once: true });
                });
            }

            await this.setupWebsocket();
            setInterval(() => this.tickTimers(), 1000);
        }

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

            // Center Deck Box
            const deckObj = await new BS.GameObject({ name: "HAH_Deck", parent: this.root, localPosition: new BS.Vector3(0, 1.05, 0) }).Async();
            await deckObj.AddComponent(new BS.BanterBox({ width: 0.3, height: 0.1, depth: 0.2 }));
            await deckObj.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.15, 0.15, 0.15, 1) }));

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
                const localUid = scene.localUser?.uid;
                const localPlayer = Object.values(this.gameState.players).find(p => p._id === localUid);
                if (!localPlayer) return;

                const cardsToSubmit = this.selectedCardIds.map(id => {
                    const card = localPlayer.cards.find(c => c && c._id === id);
                    return card ? { _id: card._id, text: card.text } : null;
                }).filter(Boolean);

                this.confirm("Submit these cards?", () => {
                    this.send("choose-cards", cardsToSubmit);
                    this.selectedCardIds = [];
                    this.updateUI();
                });
            });
            const resetBtn = await createBtn(hPanel, actionsRow, "RESET", "#FF9800", () => {
                this.selectedCardIds = [];
                this.updateUI();
            });
            const dumpBtn = await createBtn(hPanel, actionsRow, "DUMP HAND", "#F44336", () => {
                this.confirm("Dump hand ?", () => {
                    this.send("dump-hand");
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
            await centralObj.AddComponent(new BS.BanterBillboard({ enableXAxis: true, enableYAxis: true }));
            
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

            this.ui.joinBtn = await createBtn(buttonsRow, "JOIN GAME", "#2196F3", () => this.send("join-game"));
            this.ui.dealBtn = await createBtn(buttonsRow, "START ROUND", "#4CAF50", () => this.send("start-game"));
            this.ui.leaveBtn = await createBtn(buttonsRow, "LEAVE GAME", "#F44336", () => this.confirm("Leave game?", () => this.send("leave-game")));
            this.ui.muteBtn = await createBtn(buttonsRow, "🔊", "#607D8B", () => {
                this.isMuted = !this.isMuted;
                this.ui.muteBtn.text = this.isMuted ? "🔇" : "🔊";
            });

            const creditLabel = panel.CreateLabel(undefined, rootEl);
            await creditLabel.Async();
            creditLabel.text = "Cards Against Humanity LLC\nLicensed under CC BY-NC-SA\ncardsagainsthumanity.com\nAdapted for AltspaceVR by:\nDerogatory, falkrons, schmidtec\nOriginally Ported to Banter by Shane\nPorted to the New Banter SDK By FireRat";
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
                    this.send("show-black");
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
                this.send("preview-response", nextIdx);
            });
            this.ui.czarWinnerBtn = await createBtn(czarControlsRow, "CHOOSE WINNER", "#4CAF50", () => {
                const responders = Object.values(this.gameState.players)
                    .filter(p => p._id !== this.gameState.czar && p.selected && p.selected.length > 0)
                    .sort((a, b) => a._id.localeCompare(b._id));
                const activeResponse = responders[this.gameState.currentPreviewResponse || 0];
                if (activeResponse) {
                    this.confirm(`Crown this card(s) the winner?`, () => this.send("choose-winner", activeResponse._id), activeResponse.selected);
                }
            });
            this.ui.czarNextBtn = await createBtn(czarControlsRow, "NEXT", "#555", () => {
                const responders = Object.values(this.gameState.players)
                    .filter(p => p._id !== this.gameState.czar && p.selected && p.selected.length > 0)
                    .sort((a, b) => a._id.localeCompare(b._id));
                const nextIdx = Math.min(responders.length - 1, (this.gameState.currentPreviewResponse || 0) + 1);
                this.send("preview-response", nextIdx);
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

        async setupWebsocket() {
            this.ws = new WebSocket(WEBSOCKET_URL);
            this.ws.onopen = () => {
                this.log("Connected to server");
                const localUser = scene.localUser;
                this.send("init", { 
                    deck: this.params.deck, 
                    instance: this.params.instance,
                    user: { id: localUser.uid, name: localUser.name, role: "player" }
                });
            };
            this.ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                switch (msg.path) {
                    case "sync-game":
                        const prevWinner = this.gameState?.winner;
                        this.gameState = msg.data;
                        this.log("Synced game state:", this.gameState);
                        if (prevWinner && !this.gameState.winner) {
                            this.selectedCardIds = []; // Clear selections on new round
                        }
                        this.updateUI();
                        break;
                    case 'play-sound':
                        this.playSound(msg.data);
                        break;
                    case "error":
                        this.log("Server error:", msg.data);
                        break;
                }
            };
            this.ws.onerror = (e) => this.log("WebSocket error", e);
            this.ws.onclose = () => {
                this.log("WebSocket closed. Reconnecting...");
                setTimeout(() => this.setupWebsocket(), 3000);
            };
        }

        send(path, data = {}) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                const localUser = scene.localUser;
                const req = {
                    path,
                    user: { id: localUser.uid, name: localUser.name, role: "player" },
                    data
                };
                this.ws.send(JSON.stringify(req));
            }
        }

        playSound(name) {
            if (this.isMuted) return;
            const now = Date.now();
            this.audioTracker = this.audioTracker || {};
            if (this.audioTracker[name] && now - this.audioTracker[name] < 100) return;
            this.audioTracker[name] = now;

            // Convert wss:// to https:// or ws:// to http://
            const domain = WEBSOCKET_URL.replace("wss://", "https://").replace("ws://", "http://");
            const url = `${domain}Assets/${name}`;
            
            const audio = new Audio(url);
            audio.crossOrigin = "anonymous";
            audio.volume = 0.3;
            audio.play().catch(e => this.log("Audio play failed: " + e.message));
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

            // Update Central Hub
            this.ui.joinBtn.SetStyles({ display: isPlaying ? 'none' : 'flex' });
            this.ui.leaveBtn.SetStyles({ display: isPlaying ? 'flex' : 'none' });
            this.ui.creditLabel.SetStyles({ display: isPlaying ? 'none' : 'flex' });

            const numPlayers = Object.keys(players).length;
            const minPlayers = 3;
            
            if (!this.gameState.isStarted) {
                if (numPlayers < minPlayers) {
                    this.ui.statusLabel.text = `Waiting for players... (${numPlayers}/${minPlayers} joined)`;
                    this.ui.statusLabel.SetStyles({ display: 'flex' });
                    this.ui.dealBtn.SetStyles({ display: 'none' });
                } else {
                    this.ui.statusLabel.SetStyles({ display: 'none' });
                    this.ui.dealBtn.SetStyles({ display: isPlaying ? 'flex' : 'none' });
                }
            } else {
                this.ui.statusLabel.SetStyles({ display: 'none' });
                this.ui.dealBtn.SetStyles({ display: 'none' });
            }

            if (this.gameState.isStarted && this.gameState.currentBlackCard) {
                const canSeeBlack = isCzar || this.gameState.showBlack;
                if (canSeeBlack) {
                    let cardText = this.gameState.currentBlackCard.text;
                    if (isCzar && !this.gameState.showBlack) {
                        cardText += "\n\n(CLICK TO REVEAL)";
                    }
                    this.ui.blackCard.label.text = this.wrapText(cardText, 30);
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
            const allSubmitted = responders.length > 0 && responders.every(p => p.selected && p.selected.length >= numReq);
            
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
                    slice.hRoot.SetStyles({ display: 'none' });
                    continue;
                }

                slice.sRoot.SetStyles({ display: 'flex', backgroundColor: 'rgba(20, 20, 20, 0.93)' });
                slice.nameText.text = playerAtPos.name + ` (${playerAtPos.trophies || 0}🏆)`;
                
                // Inactivity & Disconnect Timer Display
                const kickTime = playerAtPos.inactivityKickTime || 0;
                const discTime = playerAtPos.disconnectKickTime || 0;
                const now = new Date().getTime();
                
                let timerStr = "";
                let secondsLeft = Infinity;
                let icon = "⏱️";

                if (kickTime > 0) {
                    secondsLeft = Math.max(0, Math.floor((kickTime - now) / 1000));
                }

                if (discTime > 0) {
                    const discSeconds = Math.max(0, Math.floor((discTime - now) / 1000));
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
                    const showHand = this.gameState.isStarted && !sliceIsCzar && !this.gameState.winner && (!playerAtPos.selected || !playerAtPos.selected.length);
                    
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
                        slice.submitBtn.SetStyles({ display: this.selectedCardIds.length === numReq ? 'flex' : 'none' });
                        slice.dumpBtn.SetStyles({ display: !playerAtPos.hasRequestedHandDumpThisRound ? 'flex' : 'none' });
                    } else {
                        slice.hRoot.SetStyles({ display: 'none' });
                        slice.statusText.text = sliceIsCzar ? "CZAR" : (playerAtPos.selected && playerAtPos.selected.length ? "READY" : "WAITING");
                    }
                } else {
                    slice.hRoot.SetStyles({ display: 'none' });
                    slice.statusText.text = sliceIsCzar ? "CZAR" : (playerAtPos.selected && playerAtPos.selected.length ? "READY" : "THINKING");
                }
            }
        }

        tickTimers() {
            if (!this.gameState || !this.ui.centralPanel) return;
            this.updateUI();
        }
    }

    const game = new BullshcriptGame();
    
    if (window.BS) {
        game.init();
    } else {
        window.addEventListener("bs-loaded", () => game.init());
    }

})();