// --- Configuration ---
const IS_LOCAL_DEV = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// When running locally, it will connect to the server on the same host.
// When deployed, it will connect to the production domain.
// If you are hosting your own server, change this URL to point to it.
const WEBSITE_DOMAIN = IS_LOCAL_DEV ? window.location.host : 'hah.firer.at';
const PROTOCOL = IS_LOCAL_DEV ? 'http' : 'https';
const WS_PROTOCOL = IS_LOCAL_DEV ? 'ws' : 'wss';

const SCRIPT_FILENAME = '/script.js';

// --- Self-Identification ---
// Find this script's own <script> tag to read its attributes. This is more robust than assuming it's the last script on the page, especially for dynamic injection.
const expectedSrc = `${PROTOCOL}://${WEBSITE_DOMAIN}${SCRIPT_FILENAME}`;
const scripts = Array.from(document.scripts);
const hahCurrentScript = document.currentScript ||
                         scripts.find(s => s.src === expectedSrc) ||
                         scripts.find(s => s.src.endsWith(SCRIPT_FILENAME)) ||
                         scripts.slice(-1)[0]; // Fallback for older browsers/edge cases

const WEBSITE_URL = `${PROTOCOL}://${WEBSITE_DOMAIN}`;
const WEBSOCKET_URL  = `${WS_PROTOCOL}://${WEBSITE_DOMAIN}`;
class HahGameSystem {
  constructor(){
    this.MAX_SUPPORTED_RESPONSES = 5; // Define a maximum number of cards the UI can show
    this.init();
  }

  log(...args) {
    if (this.isDebug) {
      console.log("HahGameSystem:", ...args);
    }
  }

  async init() {
    this.playerSelections = {};
    this.currentScript = hahCurrentScript;
    this.urlParams = new URLSearchParams(window.location.search);
    this.parseParams();
    this.log("Initializing new game system.");
    if(window.isBanter) {
      await window.AframeInjection.waitFor(window, 'user');
      await window.AframeInjection.waitFor(window, 'banterLoaded');
    }
    this.scene = document.querySelector("a-scene");
    if(!this.scene){
      return;
    }
    if(!window.user) {
      this.generateGuestUser();
    }
    this.parent = this.getTableHTML();
    await this.wait(1);
    await this.setupTable();
    await this.setupWebsocket();
    await this.wait(1);
    this.parent.setAttribute("scale", "1 1 1");
    await this.wait(1);
  }
  wait(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }
  parseParams() {
    this.setOrDefault("position", "0 0 0");
    this.setOrDefault("rotation", "0 0 0");
    this.setOrDefault("uid", null);
    this.setOrDefault("instance", "demo-game");
    this.setOrDefault("deck", "main");
    this.setOrDefault("debug", "false");
    this.setOrDefault("one-for-each-instance", "false");

    this.isDebug = this.params.debug === 'true';

    if(this.params["one-for-each-instance"] === "true" && window.user && window.user.instance) {
      this.params.instance += window.user.instance;
    }
    this.log(`Parsed params. Deck is set to: "${this.params.deck}"`);
  }
  setOrDefault(attr, defaultValue) {
    const value = this.currentScript.getAttribute(attr);
    this.params = this.params || {};
    this.params[attr] = value || (this.urlParams.has(attr) ? this.urlParams.get(attr) : defaultValue);
  }
  setupWebsocket(){
    return new Promise(resolve => {
      this.ws = new WebSocket(WEBSOCKET_URL);
      this.ws.onopen = async (event) => {
        const instance = this.params.instance;
        const user = window.user;
        const deck = this.params.deck;
        this.log(`Sending "init" message with deck: "${deck}"`);
        this.send("init", {instance, user, deck, debug: this.isDebug});
        this.log("Connected to game server.");
        resolve();
      };
      this.ws.onmessage = (event) => {
        if(typeof event.data === 'string'){
          this.parseMessage(event.data);
        }
      }
      this.ws.onclose =  (event) => {
        this.log("Connection to game server closed, reconnecting...");
        setTimeout(() => {
          this.setupWebsocket();
        }, 1000);
      };
    });
  }
  setupTable() {
    this.startCard = this.parent.querySelector("._startCard");
    this.submitWinner = this.parent.querySelector("._submitWinner");
    this.gameCard = this.parent.querySelector("._gameCard");
    this.gameBox = this.parent.querySelector("._hahBox");
    this.leaveGame = this.parent.querySelector("._leaveGame");
    this.areYouSure = this.parent.querySelector("._areYouSure");
    this.confirmButton = this.parent.querySelector("._confirm");
    this.cancelButton = this.parent.querySelector("._cancel");
    this.startPreviewCard = this.parent.querySelector("._startPreviewCard");
    this.mainCTAJoinText = this.parent.querySelector("._clickToJoin");
    this.mainCTAJoinButton = this.parent.querySelector("._clickToJoinButton");
    this.resetGameEle = this.parent.querySelector(".resetGame");
    this.resetGameEle.addEventListener('click', () => {
      this.send("reset-game");
      this.resetGame();
    });
    this.mainCTAJoinButton.addEventListener('click', this.debounce(() => {
      if(this.canStart){
        this.send('start-game');
        this.log("Starting game...");
      }else {
        this.send('join-game');
        this.log("Joining game...");
      }
    }));
    this.leaveGame.addEventListener('click', this.debounce(() => {
      this.confirm(() => {
        this.send('leave-game');
      }, "Leave game?", { hideAllUI: true });
    })); 
    if(window.isBanter) {
      Array.from(this.parent.querySelector("[look-at]")).forEach(ele => {
        ele.removeAttribute("look-at");
      });
    }
  }
  confirm(callback, message = "Are you sure?", optionsOrOnCleanup = {}) {
    let onCleanup, hideAllUI;

    if (typeof optionsOrOnCleanup === 'function') {
      onCleanup = optionsOrOnCleanup;
      hideAllUI = false;
    } else {
      onCleanup = optionsOrOnCleanup.onCleanup;
      hideAllUI = optionsOrOnCleanup.hideAllUI;
    }

    const areYouSureText = this.areYouSure.querySelector("a-text");
    this.setText(areYouSureText, message);
    this.areYouSure.setAttribute("scale", "1 1 1");

    let confirmHandler, cancelHandler;

    // If requested, hide all major UI elements to prevent overlap.
    if (hideAllUI) {
      this.hide(this.gameCard);
      this.hide(this.startCard);
      // Also hide the player's own card area if they are playing
      const userPlayer = this.game?.players[window.user?.id];
      if (userPlayer && this.userIsPlaying) {
        const playerSection = this.parent.querySelector(`._playerPosition${userPlayer.position}`);
        if (playerSection) {
          this.hide(playerSection.querySelector("._cardRoot"));
          this.hide(playerSection.querySelector("._cardSelection"));
          const reset = playerSection.querySelector("._resetCardSelection");
          const submit = playerSection.querySelector("._submitCardSelection");
          if (reset) this.hide(reset.parentElement);
          if (submit) this.hide(submit.parentElement);
        }
      }
    }

    const cleanup = () => {
      this.areYouSure.setAttribute("scale", "0 0 0");
      this.confirmButton.removeEventListener("click", confirmHandler);
      this.cancelButton.removeEventListener("click", cancelHandler);
      this.setText(areYouSureText, "Are you sure?"); // Reset for next use

      // If we hid the main UI, restore it by re-syncing the game state.
      if (hideAllUI) {
        this.syncGame(this.game);
      }

      if (onCleanup) onCleanup();
    };

    confirmHandler = () => {
      callback();
      cleanup();
    };
    cancelHandler = () => {
      cleanup();
    };

    this.confirmButton.addEventListener("click", confirmHandler);
    this.cancelButton.addEventListener("click", cancelHandler);
  }
  selectIndividualCard(cardele, submit, reset, playerSection) {
    const numResponsesRequired = this.game.currentBlackCard?.numResponses || 1;
    const playerSelectionState = this.playerSelections[window.user.id];

    if (this.hasSubmit || !playerSelectionState || playerSelectionState.selectedCardElements.length >= numResponsesRequired) {
      return;
    }

    // Hide the card from the hand and add it to our selection list
    cardele.setAttribute("scale", "0 0 0");
    playerSelectionState.selectedCardElements.push(cardele);

    // Update the preview slots
    playerSelectionState.selectedCardElements.forEach((selectedCard, index) => {
      const previewSlot = playerSelectionState.previewElements[index];
      if (previewSlot) {
        this.setText(previewSlot.querySelector("a-text"), selectedCard.card.text);
        this.show(previewSlot);
      }
    });

    // Show/hide controls based on the new state
    this.show(reset.parentElement);
    if (playerSelectionState.selectedCardElements.length === numResponsesRequired) {
      this.show(submit.parentElement);
    }

    if(playerSection.submitCallback) {
      submit.removeEventListener("click", playerSection.submitCallback);
    }
    playerSection.submitCallback = this.debounce(() => this.chooseCards(submit, reset, playerSection));
    submit.addEventListener("click", playerSection.submitCallback);
  }
  chooseCards(submit, reset, playerSection) {
    const playerSelectionState = this.playerSelections[window.user.id];
    const cardsToSend = playerSelectionState.selectedCardElements.map(el => el.card);
    this.send("choose-cards", cardsToSend);

    // Optimistically hide controls. The server sync will handle clearing the preview.
    playerSelectionState.previewElements.forEach(previewSlot => {
      this.setText(previewSlot.querySelector("a-text"), "-");
      this.hide(previewSlot);
    });
    this.hide(submit.parentElement);
    this.hide(reset.parentElement);
    this.hasSubmit = true;
  }
  resetChoice(submit, reset, playerSection) {
    const playerSelectionState = this.playerSelections[window.user.id];
    if (!playerSelectionState) return;

    // Return the selected cards to the hand visually
    playerSelectionState.selectedCardElements.forEach(cardEle => {
      cardEle.setAttribute("scale", "0.1 0.15 0.1");
    });

    // Clear the internal selection state
    playerSelectionState.selectedCardElements = [];

    // Hide the preview slots and controls
    playerSelectionState.previewElements.forEach(previewSlot => this.hide(previewSlot));
    this.hide(submit.parentElement);
    this.hide(reset.parentElement);
  }
  showTrophies(player, trophiesEl) {
    if(player.trophies > trophiesEl.children.length) {
      const new_ones = player.trophies - trophiesEl.children.length;
      for(let i = 0; i < new_ones; i++) {
        const new_trophy = document.createElement("a-entity");
        new_trophy.setAttribute('gltf-model', this.models.trophy);
        new_trophy.setAttribute('scale', '0.01 0.01 0.01');
        trophiesEl.appendChild(new_trophy);
      }
      Array.from(trophiesEl.children).forEach((d,i) => {
        d.setAttribute("position", ((i * 0.05) - (player.trophies * 0.05 / 2) + 0.015) + " 0 0");
      }); 
    }
  }
  updatePlayerSlices(players, game) {
    for(let i = 0;i < 10; i ++) {
      const playerId = players.filter(d => game.players[d].position === i);
      const playerSection = this.parent.querySelector("._playerPosition" + i);
      const reset = playerSection.querySelector("._resetCardSelection");
      const submit = playerSection.querySelector("._submitCardSelection");
      const dumpHandContainer = playerSection.querySelector("._dumpHandContainer");
      const dumpHandButton = playerSection.querySelector("._dumpHandButton");
      const playerStatusText = playerSection.querySelector("._playerStatus");
      
      // Hide all preview slots by default
      Array.from(playerSection.querySelectorAll("._cardSelection > a-plane")).forEach(slot => this.hide(slot));

      this.hide(submit.parentElement);
      this.hide(reset.parentElement);
      if(!playerId.length) {
        this.hide(playerSection);
        this.setText(playerSection.querySelector('._nameTag'), "");
        continue;
      }
      const id = playerId[0];
      const player = game.players[id];
      this.hide(dumpHandContainer);
      this.setText(playerStatusText, "");
      this.showTrophies(player, playerSection.querySelector('.trophies'));
      this.show(playerSection);
      this.setText(playerSection.querySelector('._nameTag'), player.name);
      const nameTagTimer = playerSection.querySelector('._nameTagTimer');
      
      // Clear any existing timer interval to prevent multiple running at once
      if (nameTagTimer.timer) {
        clearInterval(nameTagTimer.timer);
        nameTagTimer.timer = null;
      }

      if (!player.connected) {
        nameTagTimer.timer = setInterval(() => {
          const secondsLeft = 45 - Math.round((new Date().getTime() - player.disconnectTime) / 1000);
          this.setText(nameTagTimer, `Disconnected, kicking in ${Math.max(0, secondsLeft)}s`);
        }, 1000);
      } else if (player.inactivityKickTime > 0 && !player.selected.length) {
        nameTagTimer.timer = setInterval(() => {
          const secondsLeft = Math.round((player.inactivityKickTime - new Date().getTime()) / 1000);
          if (secondsLeft >= 0) {
            this.setText(nameTagTimer, `Inactive, kicking in ${secondsLeft}s`);
          }
        }, 1000);
      } else {
        this.setText(nameTagTimer, ""); // Clear text if no timer is active
      }

      if (player.wantsNewHand) {
        this.setText(playerStatusText, id === window.user.id ? "New hand pending..." : "Wants new hand");
      }
      
      if(game.isStarted && game.czar !== id && !game.winner) {
        this.show(playerSection.querySelector("._cardRoot"));
      }else{
        this.hide(playerSection.querySelector("._cardRoot"));
      }
      if(game.isStarted){
        if(id === window.user.id && id !== game.czar) {
          // Initialize or reset selection state for the player for this round
          if (!this.playerSelections[id] || this.hasSubmit) {
            this.log(`Initializing selection state for player ${id}`);
            this.playerSelections[id] = {
              selectedCardElements: [],
              previewElements: Array.from({ length: this.MAX_SUPPORTED_RESPONSES }, (_, j) => playerSection.querySelector(`._cardSelection${j}`))
            };
          }
          if(!playerSection.resetCallback) {
            playerSection.resetCallback = this.debounce(() => this.resetChoice(submit, reset, playerSection));
            reset.addEventListener("click", playerSection.resetCallback);
          }
          // --- New, smarter hand update logic ---
          const cardElements = Array.from({ length: 12 }, (_, i) => playerSection.querySelector('._card' + i));
          const newCardData = player.cards || [];
          
          const newCardIds = new Set(newCardData.map(c => c._id));
          const currentDomCards = cardElements.map(el => el.card).filter(Boolean);
          const currentDomCardIds = new Set(currentDomCards.map(c => c._id));

          const addedCards = newCardData.filter(c => !currentDomCardIds.has(c._id));
          const freeSlots = cardElements.filter(el => !el.card || !newCardIds.has(el.card._id));

          freeSlots.forEach((slot, index) => {
            const cardToAdd = addedCards[index];
            if (slot.clickCallback) {
              slot.removeEventListener("click", slot.clickCallback);
              slot.clickCallback = null;
            }

            if (cardToAdd) {
              slot.card = cardToAdd;
              this.setText(slot.querySelector("a-text"), cardToAdd.text);
              slot.setAttribute("scale", "0.1 0.15 0.1");
              slot.clickCallback = this.debounce(() => this.selectIndividualCard(slot, submit, reset, playerSection));
              slot.addEventListener("click", slot.clickCallback);
            } else {
              slot.card = null;
              this.setText(slot.querySelector("a-text"), "-");
              slot.setAttribute("scale", "0 0 0");
            }
          });
          // --- End of new logic ---

          // Restore button visibility and card previews based on local selection state if the player hasn't submitted yet.
          const playerSelectionState = this.playerSelections[id];
          if (playerSelectionState && !player.selected.length) {
            // Re-display the previewed cards from the local state. The main hand sync logic
            // might have re-shown the card in the hand, so we need to hide it again here.

              // Ensure the parent container for previews is visible, as it might have been hidden by the confirm dialog.
              const previewContainer = playerSection.querySelector("._cardSelection");
              if (previewContainer) this.show(previewContainer);


            playerSelectionState.selectedCardElements.forEach((selectedCardElement, index) => {
              const previewSlot = playerSelectionState.previewElements[index];
              if (previewSlot) {
                this.setText(previewSlot.querySelector("a-text"), selectedCardElement.card.text);
                this.show(previewSlot);
              }
              // Explicitly hide the card from the hand, as the sync logic would have re-shown it.
              selectedCardElement.setAttribute("scale", "0 0 0");
            });

            const numResponsesRequired = game.currentBlackCard?.numResponses || 1;
            if (playerSelectionState.selectedCardElements.length > 0) {
              this.show(reset.parentElement);
            }
            if (playerSelectionState.selectedCardElements.length === numResponsesRequired) {
              this.show(submit.parentElement);
            }
          }

          if (game.isStarted && !game.winner && !player.hasRequestedHandDumpThisRound) {
            this.show(dumpHandContainer);
            if (!dumpHandButton.clickCallback) {
              dumpHandButton.clickCallback = this.debounce(() => {
                this.confirm(
                  () => { this.send('dump-hand'); },
                  "Discard hand?",
                  { hideAllUI: true }
                );
              });
              dumpHandButton.addEventListener('click', dumpHandButton.clickCallback);
            }
          } else {
            this.hide(dumpHandContainer);
            if (dumpHandButton.clickCallback) {
              dumpHandButton.removeEventListener('click', dumpHandButton.clickCallback);
              dumpHandButton.clickCallback = null;
            }
          }
        }
      }
      this.currentBlackCard = playerSection.querySelector("._cardCzar");
      this.currentBlackCard.setAttribute("scale", game.isStarted && game.czar === id && !game.winner ? "0.1 0.15 0.1" : "0 0 0");
      if(id === game.czar) {
        this.hide(submit.parentElement);
        this.hide(reset.parentElement);
        this.show(playerSection.querySelector('._playerSliceActive'));
        this.hide(playerSection.querySelector('._playerSlice'));
        if(game.czar === window.user.id) {
          this.setText(this.currentBlackCard.querySelector("a-text"), game.currentBlackCard.text);
          if(this.currentBlackCard.showCallback) {
            this.currentBlackCard.removeEventListener("click", this.currentBlackCard.showCallback);
          }
          this.currentBlackCard.showCallback = this.debounce(() => {
            this.show(this.gameCard);
            this.send("show-black");
          });
          this.currentBlackCard.addEventListener("click", this.currentBlackCard.showCallback);
        }
      }else{
        this.hide(playerSection.querySelector('._playerSliceActive'));
        this.show(playerSection.querySelector('._playerSlice'));
      }
    }
  }
  debounce(click) {
    return () => {
      // OK i changed to throttling instead of debounce, havent updated the name yet.
      const now = new Date().getTime();
      if(this.lastClickTime && now - this.lastClickTime < 200) {
        return () => {};
      }
      this.lastClickTime = now;
      click();
    }
  }
  resetGame() {
    // Dynamically find and reset all czar response cards
    for (let i = 0; i < this.MAX_SUPPORTED_RESPONSES; i++) {
      const cardContainer = this.gameCard.querySelector(`._czarResponseCardContainer${i}`);
      if (cardContainer) {
        this.hide(cardContainer);
        const textElement = cardContainer.querySelector(`._cardCzar${i + 1}`);
        if (textElement) this.setText(textElement, "-");
      }
    }
    const cardCzar0 = this.gameCard.querySelector("._cardCzar0");
    this.setText(cardCzar0, "-");
    cardCzar0.previousSibling.previousSibling.setAttribute("position", "0 0 0");
    cardCzar0.setAttribute("position", "0.33 0.45 -0.02");

    // Reset player-specific state
    this.playerSelections = {};
    this.hasSubmit = false;

    // Reset all player slices in the DOM
    for(let i = 0;i < 10; i ++) {
      const playerSection = this.parent.querySelector("._playerPosition" + i);
      if (!playerSection) continue;

      // Hide all player-side preview slots
      Array.from(playerSection.querySelectorAll("._cardSelection > a-plane")).forEach(slot => {
        const textElement = slot.querySelector("a-text");
        if (textElement) this.setText(textElement, "-");
        this.hide(slot);
      });

      const reset = playerSection.querySelector("._resetCardSelection");
      const submit = playerSection.querySelector("._submitCardSelection");
      this.hide(submit.parentElement);
      this.hide(reset.parentElement);

      // Reset hand cards
      for(let _i = 0;_i < 12; _i ++) {
        const cardEle = playerSection.querySelector('._card' + _i);
        if (!cardEle) continue;
        cardEle.card = null;
        this.setText(cardEle.querySelector("a-text"), "-");
        if(cardEle.clickCallback) {
          cardEle.removeEventListener("click", cardEle.clickCallback);
          cardEle.clickCallback = null;
        }
      };
    }
  }
  centerTableState(game) {
    let value = "Click To Join";
    if(this.userIsPlaying) {
      if(game.playerCount > 2) {
        if(game.winner) {
          this.show(this.startCard);
          value = game.winner.name + " wins!";
          this.hide(this.gameCard);
        }else if(game.isStarted) {
          this.hide(this.mainCTAJoinButton);
          this.canStart = false;
          this.gameBox.setAttribute("rotation", "0 0 0");
          value = "";
          this.hide(this.startCard);
        }else{
          value = "Click To Deal";
          this.canStart = true;
          this.show(this.mainCTAJoinButton);
          
        }
      }else{
        value = (3 - game.playerCount) + " More!";
        this.hide(this.mainCTAJoinButton);
      }
    }else if(this.userIsWaiting) {
      this.hide(this.mainCTAJoinButton);
      this.hide(this.startCard);
      value = "Waiting for next round...";
    }else{
      this.show(this.startCard);
      this.show(this.startPreviewCard);
      this.show(this.mainCTAJoinButton);
      if(game.isStarted) {
        this.hide(this.startPreviewCard);
      }
      value = "Click To Join";
    }
    if(game.playerCount > 9) {
      this.hide(this.mainCTAJoinButton);
      value = "Game Full";
    }
    this.setText(this.mainCTAJoinText, value);
  }
  czarPreviewAndSelect(players, game) {
    if (!game.showBlack || game.winner) {
      this.hide(this.gameCard);
      this.log("Hiding game card, showBlack:", game.showBlack, "winner:", game.winner);
      return;
    }

    this.show(this.gameCard);
    this.currentPlayer  = game.currentPreviewResponse || 0;
    const responses = this._getShuffledResponses(players, game);
    const numResponsesRequired = game.currentBlackCard?.numResponses || 1;
    // Ensure we don't get a false positive on an empty array.
    this.log("Czar Preview - currentPreviewResponse:", game.currentPreviewResponse, "responses.length", responses.length);
    const areAllResponsesIn = responses.length > 0 && responses.every(p => p.selected && p.selected.length >= numResponsesRequired);

    this._updateCzarPreviewLayout(responses, game, areAllResponsesIn);
    
    if (window.user.id === game.czar) {
      this._bindCzarPreviewControls(responses, areAllResponsesIn);
    } else {
      // Hide controls if the current user is not the czar.
      const czarControls = [
        this.gameCard.querySelector("._prevPlayerResponse").parentElement,
        this.gameCard.querySelector("._nextPlayerResponse").parentElement,
        this.submitWinner.parentElement
      ];
      czarControls.forEach(c => this.hide(c));
    }
  }
  _getShuffledResponses(players, game) {
    const gamePlayersWithoutCzar = players
      .filter(id => id !== game.czar)
      .map(id => game.players[id]);

    if (gamePlayersWithoutCzar.length > 1 && game.isStarted && game.currentBlackCard) {
      const playerIDs = players.filter(id => id !== game.czar).sort();
      const seedString = game.czar + playerIDs.join('') + game.currentBlackCard.text;
      let seed = 0;
      for (let i = 0; i < seedString.length; i++) {
        seed += seedString.charCodeAt(i);
      }
      this.seededShuffle(gamePlayersWithoutCzar, seed);
    }
    return gamePlayersWithoutCzar;
  }
  _updateCzarPreviewLayout(responses, game, areAllResponsesIn) {
    const numResponsesRequired = game.currentBlackCard?.numResponses || 1;
    const cardCzar0 = this.gameCard.querySelector("._cardCzar0");
    const blackCardContainer = this.gameCard.querySelector("._blackCardModel");
    // Get all response card containers dynamically
    const responseCardContainers = Array.from({ length: this.MAX_SUPPORTED_RESPONSES }, (_, i) => this.gameCard.querySelector(`._czarResponseCardContainer${i}`));
    const responseCardTextElements = Array.from({ length: this.MAX_SUPPORTED_RESPONSES }, (_, i) => this.gameCard.querySelector(`._cardCzar${i + 1}`));

    this.setText(cardCzar0, game.currentBlackCard.text);

    if (!areAllResponsesIn) {
      // Hide all response cards and center the black card
      responseCardContainers.forEach(c => c && this.hide(c));
      blackCardContainer.setAttribute("position", "0 0 0");
      cardCzar0.setAttribute("position", "-0.35 0.45 0.02");
      this.log("Not all responses in, hiding response cards.");
    } else {
      // Dynamic layout for black card and response cards
      const cardWidth = 0.8; // Approximate width of a card container
      const totalWidth = (numResponsesRequired + 1) * cardWidth;
      const startX = -totalWidth / 2 + cardWidth / 2;

      // Position black card
      const blackCardX = startX;
      blackCardContainer.setAttribute("position", `${blackCardX} 0 0`);
      cardCzar0.setAttribute("position", `${blackCardX - 0.33} 0.45 0.02`);

      // Position response cards
      responseCardContainers.forEach((container, index) => {
        if (!container) return;
        if (index < numResponsesRequired) {
          const responseCardX = startX + (index + 1) * cardWidth;
          container.setAttribute("position", `${responseCardX} 0 0`);
          this.show(container);
        } else {
          this.hide(container);
        }
      });

      // Update the text of the response cards for the currently previewed response
      const currentResponse = responses[this.currentPlayer];
      responseCardTextElements.forEach((textElement, index) => {
        if (textElement) {
          const cardText = currentResponse?.selected[index]?.text || "";
          this.log(`Setting cardCzar${index + 1} text to:`, cardText);
          this.setText(textElement, cardText);
        }
      });
      this.log("All responses in, updating response card positions.");

      // Also update the next/prev button visibility based on the current state
      const prevBtn = this.gameCard.querySelector("._prevPlayerResponse");
      const nextBtn = this.gameCard.querySelector("._nextPlayerResponse");
      this.showHideNextPrev(nextBtn, prevBtn, responses.length - 1);
    }
  }
  _bindCzarPreviewControls(responses, areAllResponsesIn) {
    const prevBtn = this.gameCard.querySelector("._prevPlayerResponse");
    const nextBtn = this.gameCard.querySelector("._nextPlayerResponse");
    const czarControls = [prevBtn.parentElement, nextBtn.parentElement, this.submitWinner.parentElement];

    if (!areAllResponsesIn) {
      czarControls.forEach(c => this.hide(c));
      return;
    }

    czarControls.forEach(c => this.show(c));

    // Cleanup old listeners to prevent memory leaks and double-firing
    if (this.gameCard.nextPlayerResponseCallback) nextBtn.removeEventListener("click", this.gameCard.nextPlayerResponseCallback);
    if (this.gameCard.prevPlayerResponseCallback) prevBtn.removeEventListener("click", this.gameCard.prevPlayerResponseCallback);
    if (this.submitWinner.clickCallback) this.submitWinner.removeEventListener("click", this.submitWinner.clickCallback);

    // Next Button
    this.gameCard.nextPlayerResponseCallback = this.debounce(() => {
      this.currentPlayer = Math.min(this.currentPlayer + 1, responses.length - 1);
      this.send("preview-response", this.currentPlayer);
    });
    nextBtn.addEventListener("click", this.gameCard.nextPlayerResponseCallback);

    // Previous Button
    this.gameCard.prevPlayerResponseCallback = this.debounce(() => {
      this.currentPlayer = Math.max(this.currentPlayer - 1, 0);
      this.send("preview-response", this.currentPlayer);
    });
    prevBtn.addEventListener("click", this.gameCard.prevPlayerResponseCallback);

    // Submit Winner Button
    this.submitWinner.clickCallback = this.debounce(() => {
      const winningPlayer = responses[this.currentPlayer];
      const onCleanup = () => {
        czarControls.forEach(c => this.show(c));
        this.showHideNextPrev(nextBtn, prevBtn, responses.length - 1);
      };
      czarControls.forEach(c => this.hide(c));
      this.confirm(() => this.send("choose-winner", winningPlayer._id), "Confirm this card?", onCleanup);
    });
    this.submitWinner.addEventListener("click", this.submitWinner.clickCallback);
  }
  seededShuffle(array, seed) {
    let currentIndex = array.length, randomIndex;
    const random = () => {
      const x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    };

    while (currentIndex !== 0) {
      randomIndex = Math.floor(random() * currentIndex);
      currentIndex--;

      [array[currentIndex], array[randomIndex]] = [
        array[randomIndex], array[currentIndex]];
    }

    return array;
  }
  showHideNextPrev(next, prev, total) {
    if(this.currentPlayer <= 0) {
      prev.parentElement.setAttribute("scale", "0 0 0")
    }else{
      prev.parentElement.setAttribute("scale", "0.6 0.6 0.6")
    }
    
    if(this.currentPlayer >= total) {
      next.parentElement.setAttribute("scale", "0 0 0")
    }else{
      next.parentElement.setAttribute("scale", "0.6 0.6 0.6")
    }
    
  }
  hide(ele) {
    if(this.mainCTAJoinButton === ele) {
      ele.setAttribute('scale', '0 0 0');
    }
    ele.setAttribute('visible', false);
  }
  show(ele) {
    if(this.mainCTAJoinButton === ele) {
      ele.setAttribute('scale', '0.7 0.7 0.7');
    }
    ele.setAttribute('visible', true);
  }
  cleanUpTrophies(newGame) {
    const currentPlayers = Object.keys(this.game);
    const removedPlayers = currentPlayers.filter(p => !Object.keys(newGame).includes(p));
    removedPlayers.forEach(p => {
      const playerId = this.game.players[p].position;
      const playerSection = this.parent.querySelector("._playerPosition" + playerId);
      if(playerSection) {
        const reset = playerSection.querySelector("._resetCardSelection");
        const submit = playerSection.querySelector("._submitCardSelection");
        this.hide(submit.parentElement);
        this.hide(reset.parentElement);
        Array.from(playerSection.querySelector('.trophies').children).forEach(trophie => {
          trophie.parentElement.removeChild(trophie);
        })
      }
    });
  }
  syncGame(game) {
    if(this.game) {
      this.cleanUpTrophies(game);
    }
    
    this.log("syncGame: New game state received", game);
    this.game = game;
    this.canStart = false;
    
    if(!game.winner && this.hadWinner) {
      this.resetGame();
      this.hadWinner = false;
    }
    this.hadWinner = !!game.winner;
    
    const players = Object.keys(game.players);
    this.userIsPlaying = players.indexOf(window.user.id) > -1;
    if(this.userIsPlaying) {
      this.leaveGame.setAttribute("scale", "1 1 1");
    }else{
      this.leaveGame.setAttribute("scale", "0 0 0");
    }
    this.userIsWaiting = game.waitingRoom.map(d => d.id).indexOf(window.user.id) > -1;
    
    this.centerTableState(game);
    this.updatePlayerSlices(players, game);
    this.czarPreviewAndSelect(players, game);
  }
  setText(ele, value) {
    if(window.isBanter) {
      setTimeout(()=>{
        window.setText(ele.object3D.id, value);
      }, 500);
    }else{
      ele.setAttribute("value", value);
    }
  }
  parseMessage(msg) {
    const json = JSON.parse(msg);
    switch(json.path) {
      case 'sync-game':
        this.syncGame(json.data);
        break;
      case 'error':
        alert(json.data);
        break;
      case 'play-sound':
        this.playSound(json.data);
        break;
    }
  }
  playSound(name) {
    // Use a global tracker to prevent double-audio from multiple instances.
    window.hahAudioTracker = window.hahAudioTracker || {};
    const now = Date.now();
    const lastPlayed = window.hahAudioTracker[name] || 0;

    // If the same sound was played in the last 100ms, ignore this new request.
    if (now - lastPlayed < 100) {
      return;
    }
    window.hahAudioTracker[name] = now;

    const audio = new Audio(`${WEBSITE_URL}/Assets/${name}`);
    audio.volume = 0.3;
    audio.play();
  }
  send(path, data){
    this.ws.send(JSON.stringify({path, data}));
  }   
  generateGuestUser() {
    const id = this.params.uid || this.getUniquId();
    window.user = {id, name: "Guest " + id};
    localStorage.setItem('user', JSON.stringify(window.user));
  } 
  getUniquId() {
    return (Math.random() + 1).toString(36).substring(7);
  }
  getTableHTML() {
    this.models = {
      playerSlice:`${WEBSITE_URL}/Assets/ha_h__player_slice.glb`,
      playerSliceActive: `${WEBSITE_URL}/Assets/ha_h__player_slice%20(1).glb`,
      namePlate: `${WEBSITE_URL}/Assets/ha_h__name_plate.glb`,
      trophy: `${WEBSITE_URL}/Assets/ha_h__trophy.glb`
    }
    
    const czarSelectHtml = `<a-entity class="_cardSelection">
      ${Array.from({ length: this.MAX_SUPPORTED_RESPONSES }, (_, i) => `
        <a-plane visible="false" class="_cardSelection${i}" position="${0.25 - i * 0.11} 1.65 -1.3" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 180 0">
          <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.4 0.4 0.01"></a-text>
        </a-plane>
      `).join('')}
    </a-entity>`;
    
    const czarCardHtml = `
        <a-plane class="_cardCzar" sq-collider sq-interactable data-raycastable position="0 1.46 -1.4" scale="0.1 0.15 0.1" color="#000000" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 180 0" visiable="false">
          <a-text baseline="top" value="-" scale="0.4 0.3 0.4" position="-0.4 0.4 0.01"></a-text>
        </a-plane>`;
    const resetHtml = `
        <a-entity scale="0.6 0.6 0.6" position="0.4 1.5 -1.3">
          <a-entity data-raycastable sq-boxcollider="size: 0.3 0.2 0.05" sq-interactable rotation="0 0 0" class="_resetCardSelection" gltf-model="${WEBSITE_URL}/Assets/ButtonS.glb"></a-entity>
          <a-plane position="0 0 0" scale="0.2 0.2 0.2" transparent="true" src="${WEBSITE_URL}/Assets/cross.png" rotation="0 180 0"></a-plane> 
        </a-entity>
        <a-entity scale="0.6 0.6 0.6" position="-0.4 1.5 -1.3">
          <a-entity data-raycastable sq-boxcollider="size: 0.3 0.2 0.05" sq-interactable rotation="0 0 0" class="_submitCardSelection" gltf-model="${WEBSITE_URL}/Assets/ButtonS.glb"></a-entity>
          <a-plane position="0 0 0" scale="0.2 0.2 0.2" transparent="true" src="${WEBSITE_URL}/Assets/check.png" rotation="0 180 0"></a-plane> 
        </a-entity>
        <a-entity class="_dumpHandContainer" scale="0.6 0.6 0.6" position="-0.45 1.2 -1.3" visible="false">
          <a-entity data-raycastable sq-boxcollider="size: 0.3 0.2 0.05" sq-interactable rotation="0 0 0" class="_dumpHandButton" gltf-model="${WEBSITE_URL}/Assets/ButtonS.glb"></a-entity>
          <a-plane position="0 0 0" scale="0.15 0.15 0.15" transparent="true" src="${WEBSITE_URL}/Assets/trash.png" rotation="0 180 0"></a-plane>
        </a-entity>
        
       <!-- <a-plane class="_resetCardSelection" data-raycastable sq-boxcollider="size: 1 1 0.05" sq-interactable position="0.4 1.5 -1.3" scale="0.1 0.1 0.1" transparent="true" src="${WEBSITE_URL}/Assets/cross.png" rotation="0 180 0" visible="false"></a-plane> -->  
       <!--  <a-plane class="_submitCardSelection" data-raycastable sq-boxcollider="size: 1 1 0.05" sq-interactable position="-0.4 1.5 -1.3" scale="0.1 0.1 0.1" transparent="true" src="${WEBSITE_URL}/Assets/check.png" rotation="0 180 0" visible="false"></a-plane> -->`;
    const cardsHtml = `
      <a-entity class="_cardRoot" position="0 1.4 -1.3" rotation="-30 180 0" visible="false">
        <a-plane data-raycastable sq-collider sq-interactable class="_card0" position="0.265 -0.04 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 -10">
          <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
        </a-plane>
        <a-plane data-raycastable sq-collider sq-interactable class="_card1" position="0.16 -0.015 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 -6">
          <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
        </a-plane> 
        <a-plane data-raycastable sq-collider sq-interactable class="_card2" position="0.055 0 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 -3">
          <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
        </a-plane>
        <a-plane data-raycastable sq-collider sq-interactable class="_card3" position="-0.055 0 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 3">
          <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
        </a-plane>sd
        <a-plane data-raycastable sq-collider sq-interactable class="_card4" position="-0.16 -0.015 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 6">
          <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
        </a-plane>
        <a-plane data-raycastable sq-collider sq-interactable class="_card5" position="-0.265 -0.04 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 10">
          <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
        </a-plane>
        <a-entity position="0 -0.155 0">
          <a-plane data-raycastable sq-collider sq-interactable class="_card6" position="0.265 -0.04 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 -10">
            <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
          </a-plane>
          <a-plane data-raycastable sq-collider sq-interactable class="_card7" position="0.16 -0.015 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 -6">
            <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
          </a-plane>
          <a-plane data-raycastable sq-collider sq-interactable class="_card8" position="0.055 0 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 -3">
            <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
          </a-plane>
          <a-plane data-raycastable sq-collider sq-interactable class="_card9" position="-0.055 0 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 3">
            <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
          </a-plane>
          <a-plane data-raycastable sq-collider sq-interactable class="_card10" position="-0.16 -0.015 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 6">
            <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
          </a-plane>
          <a-plane data-raycastable sq-collider sq-interactable class="_card11" position="-0.265 -0.04 0" scale="0.1 0.15 0.1" color="#FFF" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" rotation="0 0 10">
            <a-text baseline="top" value="-" color="#000" scale="0.4 0.3 0.4" position="-0.45 0.4 0.01"></a-text>
          </a-plane>
        </a-entity>
      </a-entity>`;
    const playerSection = Array.from({length: 10}, (v, i) => i).map(i => `<a-entity class="_playerPosition${i}" rotation="0 ${36*i} 0">
          ${cardsHtml}
          ${czarCardHtml}
          ${czarSelectHtml}
          ${resetHtml}
          <a-entity class="_playerSliceActive" gltf-model="${this.models.playerSliceActive}"  scale="0.01 0.01 0.01"></a-entity>
          <a-entity class="_playerSlice" gltf-model="${this.models.playerSlice}"  scale="0.01 0.01 0.01"></a-entity>
          <a-text class="_playerStatus" position="0 1.15 -1.37" align="center" rotation="-30 0 0" value="" scale="0.08 0.08 0.08" color="yellow"></a-text>
          <a-text class="_nameTagTimer" position="0 1.07 -1.37" align="center" rotation="-30 0 0" value="" scale="0.08 0.08 0.08"></a-text>
          <a-entity class="_namePlate" gltf-model="${this.models.namePlate}" position="0 1 -1.4" scale="0.01 0.01 0.01"></a-entity>
          <!-- <a-box position="0 1.08 -1.45" scale="0.2 0.01 0.01" color="green"></a-box> -->
          <a-text class="_nameTag" position="0 1.07 -1.43" align="center" rotation="-30 180 0" value="Nametag" scale="0.08 0.08 0.08"></a-text>
          <a-entity class="trophies" position="0 1.02 -1.3">
          </a-entity>
        </a-entity>`).join("");
    const html = `
      <a-box scale="0.1 0.1 0.1" color="red" class="resetGame" data-raycastable sq-collider sq-interactable position="0 0.05 0"></a-box>
      <a-entity sq-nonconvexcollider="recursive: true" sq-interactable="recursive: true" gltf-model="${WEBSITE_URL}/Assets/ha_h__table_main.glb" scale="0.01 0.01 0.01"></a-entity>
        ${playerSection}
        <a-entity position="0 1.3 0.1" sq-billboard look-at="[camera]" scale="0 0 0" class="_areYouSure">
          <a-plane scale="0.5 0.3 1" color="#000" rotation="0 0 0" material="shader: flat;"></a-plane>
          <a-text baseline="center" align="center" value="Are you sure?" scale="0.25 0.25 1" position="0 0.07 0.01"></a-text>
          <a-entity position="-0.1 -0.05 0.1" scale="0.6 0.6 0.6">
            <a-entity data-raycastable sq-boxcollider="size: 0.3 0.2 0.05" sq-interactable rotation="0 180 0" class="_cancel" gltf-model="${WEBSITE_URL}/Assets/ButtonS.glb"></a-entity>
            <a-plane position="0 0 0" scale="0.2 0.2 0.2" transparent="true" src="${WEBSITE_URL}/Assets/cross.png" rotation="0 0 0"></a-plane> 
          </a-entity>
          <a-entity position="0.1 -0.05 0.1" scale="0.6 0.6 0.6">
            <a-entity data-raycastable sq-boxcollider="size: 0.3 0.2 0.05" sq-interactable rotation="0 180 0" class="_confirm" gltf-model="${WEBSITE_URL}/Assets/ButtonS.glb"></a-entity>
            <a-plane position="0 0 0.2" scale="0.2 0.2 0.2" transparent="true" src="${WEBSITE_URL}/Assets/check.png" rotation="0 0 0"></a-plane> 
          </a-entity>
        </a-entity>
        
        <a-entity position="0 2 0" class="_gameCard"  visible="false">
          <a-entity sq-billboard look-at="[camera]">
            <a-entity class="_blackCardModel" gltf-model="${WEBSITE_URL}/Assets/card%20(1).glb" scale="12.8 12.8 12.8" position="0 0 0" rotation="-90 0 0"></a-entity>
            <a-text class="_cardCzar0" baseline="top" value="-" scale="0.3 0.3 0.3" rotation="0 0 0" position="0.31 0 0.021"></a-text>
            ${Array.from({ length: this.MAX_SUPPORTED_RESPONSES }, (_, i) => `
              <a-plane class="_czarResponseCardContainer${i}" position="0 0 0" scale="0.75 1.125 0.75" color="#FFF" rotation="0 0 0" src="${WEBSITE_URL}/Assets/hero-texture.png" side="double" visible="false">
                <a-text class="_cardCzar${i + 1}" color="#000" baseline="top" value="-" scale="0.375 0.25 0.375" position="-0.4 0.4 0.01"></a-text>
              </a-plane>
            `).join('')}
          </a-entity>
          
          <a-entity sq-billboard look-at="[camera]" position="0 -0.7 0">          
            <a-entity visible="false" position="-0.1 0 0" scale="0.6 0.6 0.6">
              <a-entity data-raycastable sq-boxcollider="size: 0.3 0.2 0.05" sq-interactable rotation="0 180 0" class="_prevPlayerResponse" gltf-model="${WEBSITE_URL}/Assets/ButtonS.glb"></a-entity>
              <a-text value=">" align="center" rotation="0 180 0"></a-text>
            </a-entity>
            <a-entity position="0.1 0 0" visible="false" scale="0.6 0.6 0.6">
              <a-entity data-raycastable sq-boxcollider="size: 0.3 0.2 0.05" sq-interactable rotation="0 180 0" class="_nextPlayerResponse" gltf-model="${WEBSITE_URL}/Assets/ButtonS.glb"></a-entity>
              <a-text value="<" align="center" rotation="0 180 0"></a-text>
            </a-entity>
            <a-entity position="0.3 0 0" visible="false" scale="0.6 0.6 0.6">
              <a-entity data-raycastable sq-boxcollider="size: 0.3 0.2 0.05" sq-interactable rotation="0 180 0" class="_submitWinner" gltf-model="${WEBSITE_URL}/Assets/ButtonS.glb"></a-entity>
              <a-plane position="0 0 0" scale="0.2 0.2 0.2" transparent="true" src="${WEBSITE_URL}/Assets/check.png" rotation="0 0 0"></a-plane> 
            </a-entity>
          </a-entity>
        </a-entity>

        <a-text value="" sq-billboard look-at="[camera]" class="_clickToJoin" align="center" scale="0.3 0.3 0.3" rotation="0 180 0" position="0 1.3 0"></a-text>
        
        <a-entity position="0 2 0" class="_startCard">
          <a-entity sq-billboard look-at="[camera]" position="0 -0.7 0" >
            <a-entity class="_clickToJoinButton" visible="false" data-raycastable sq-boxcollider="size: 0.6 0.2 0.05" sq-interactable gltf-model="${WEBSITE_URL}/Assets/ButtonL.glb" scale="0.7 0.7 0.7" rotation="0 180 0"></a-entity>
          </a-entity>
          <a-entity sq-billboard look-at="[camera]" class="_startPreviewCard">
            <a-entity gltf-model="${WEBSITE_URL}/Assets/card%20(1).glb" scale="10 10 10" position="0 0 0" rotation="-90 0 0"></a-entity>
            <a-text value="Holograms\nAgainst\nHumanity" scale="0.45 0.45 0.45" rotation="0 180 0" position="0.25 0.2 -0.02"></a-text>
            <a-text value="Cards Against Humanity LLC\nLicensed under CC BY-NC-SA\ncardsagainsthumanity.com\nAdapted for AltspaceVR by:\nDerogatory, falkrons, schmidtec\nPorted to Banter by Shane\nImproved by FireRat" scale="0.15 0.15 0.15" rotation="0 180 0" position="0.25 -0.25 -0.02" material="shader: flat;"></a-text>
            <a-entity rotation="0 180 0">
              <a-text value="Holograms\nAgainst\nHumanity" scale="0.45 0.45 0.45" rotation="0 180 0" position="0.25 0.2 -0.02" material="shader: flat;"></a-text>
              <a-text value="Cards Against Humanity LLC\nLicensed under CC BY-NC-SA\ncardsagainsthumanity.com\nAdapted for AltspaceVR by:\nDerogatory, falkrons, schmidtec\nPorted to Banter by Shane\nImproved by FireRat" scale="0.15 0.15 0.15" rotation="0 180 0" position="0.25 -0.25 -0.02" material="shader: flat;"></a-text>
            </a-entity>
          </a-entity>
        </a-entity>
        <a-entity position="0 1.08 0" scale="0 0 0" class="_leaveGame">
          <a-text baseline="center" color="red" align="center" value="Click to exit" scale="0.25 0.25 1" rotation="-90 0 0" position="0 0.06 0" material="shader: flat;"></a-text>
          <a-box data-raycastable sq-boxcollider sq-interactable position="0 -0.01 0" scale="0.48 0.11 0.17"></a-box>
        </a-entity>
        <a-entity class="_hahBox" gltf-model="${WEBSITE_URL}/Assets/box.glb" position="0 1.08 0" rotation="-180 0 0" scale="2 2 2" ></a-entity>
        <a-ring rotation="-90 0 0" radius-inner="0.12" radius-outer="0.17" position="0 1 0" color="#118e98" animation="property: position; from: 0 1 0; to: 0 0.86 0; loop: true; dir: alternate; easing: linear; dur: 3000"></a-ring>
        <a-ring rotation="-90 0 0" radius-inner="0.18" radius-outer="0.23" position="0 1 0" color="#118e98" animation="property: position; from: 0 0.98 0; to: 0 0.88 0; loop: true; dir: alternate; easing: linear; dur: 3000;"></a-ring>
        <a-ring rotation="-90 0 0" radius-inner="0.24" radius-outer="0.29" position="0 1 0" color="#118e98" animation="property: position; from: 0 0.96 0; to: 0 0.90 0; loop: true; dir: alternate; easing: linear; dur: 3000;"></a-ring>
        
        `;
    
      const parent = document.createElement("a-entity");
      parent.setAttribute("position", this.params.position);
      parent.setAttribute("rotation", this.params.rotation);
      parent.setAttribute("scale", "0 0 0");
      parent.insertAdjacentHTML('beforeEnd', html);
      document.querySelector('a-scene').appendChild(parent);
    return parent;
  }
}
if(window.isBanter) {
  window.loadDoneCallback = () => window.banterLoaded = true;
}
if (!window.gameSystem) {
  window.gameSystem = new HahGameSystem();
}
