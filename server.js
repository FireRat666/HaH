const { WebSocketServer } = require('ws');
const express = require('express');
const http = require('http');
const winston = require('winston');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs').promises;

// --- Configuration ---
// Timeout in seconds before a disconnected player is removed from the game.
const DISCONNECT_TIMEOUT_SECONDS = 45;
// Timeout in seconds before an idle player (or czar) is removed for inactivity.
const IDLE_TIMEOUT_SECONDS = 90;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'server.log' })
  ],
});

class GameServer{
  constructor() {
    logger.info("game starting...");
    this.setupServer();
    this.games = {}
  }
  setupServer() {  
    
    this.app = express();
    
    this.server = http.createServer( this.app );
    
    this.wss = new WebSocketServer({ noServer: true });
    
    this.server.on('upgrade', (request, socket, head) => {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      }); 
    }); 
     
    // Replicate startAutoPing functionality from cws
    this.pingInterval = setInterval(() => {
      this.wss.clients.forEach(ws => {
        // ws.isAlive is a custom property we'll use to track connection health
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping(() => {}); // no-op, just sending a ping
      });
    }, 10000);

    this.wss.on('connection', (ws, req) => {
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      //  ws.send({path: 'initial-state', data: this.room.data});
      ws.on('message', msg => {
        try{
          if(msg !== "keepalive") {
            this.parseMessage(msg, ws); 
          }
        }catch(e) {
          logger.error('Parse error:', e);
        } 
      });
      ws.on('close', (code, reason) => {
        this.handleClose(ws);
      });
    });
    
    // Enable CORS for all routes. This will allow your script to be loaded from different domains.
    this.app.use(cors());

    /*
    // For a more secure production environment, you might want to restrict this
    // to only the domains you trust.
    const corsOptions = {
      origin: ['https://example.com', 'https://ex.ample.com']
    };
    this.app.use(cors(corsOptions));
    */

    this.app.use(express.static(path.join(__dirname, 'public')));

    const port = process.env.PORT || 3000;
    this.server.listen( port, '0.0.0.0', () => {
      logger.info(`Server started on port ${port}, listening on 0.0.0.0`);
    });
    
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }
  shutdown() {
    logger.info('Shutting down server...');
    clearInterval(this.pingInterval);
    this.wss.close();
    this.server.close(() => logger.info('Server closed.'));
  }
  handleClose(ws) { 
    const name = ws.u ? ws.u.name : 'Unknown';
    logger.info(`${name} disconnected.`);
    Object.keys(this.games).forEach(key => {
      const game = this.games[key];
      if(ws.u && game.players[ws.u.id]) {
        game.players[ws.u.id].connected = false;
        game.players[ws.u.id].disconnectTime = new Date().getTime();
        logger.info(`Player ${name} will be kicked in ${DISCONNECT_TIMEOUT_SECONDS} seconds for inactivity.`);
        game.players[ws.u.id].disconnectKickTimeout = setTimeout(() =>{
          if(!game.players[ws.u.id] || !game.players[ws.u.id].connected) {
            logger.info(`${name} kicked for inactivity.`);
            this.removePlayer(ws);
          }
        }, 1000 * DISCONNECT_TIMEOUT_SECONDS);
        this.syncGame(game);
      } 
      if(ws.u && game.waitingRoom.map(d => d.id).indexOf(ws.u.id) > -1) { 
        logger.info(`Player ${name} removed from waiting list.`);
        game.waitingRoom = game.waitingRoom.filter(d => d.id !== ws.u.id);
      }
    }); 
  } 
  async parseMessage(msg, ws) {
    let json = JSON.parse(msg);
    switch(json.path) {
      case "init":
        await this.handleInit(json.data, ws);
        break;
      case "join-game":
        await this.joinGame(json, ws);
        break;
      case "start-game":
        await this.startGame(ws);
        break;
      case "leave-game":
        await this.leaveGame(ws);
        break;
      case "show-black":
        await this.showBlack(ws);
        break; 
      case "preview-response":
        await this.previewResponse(json, ws);
        break; 
      case "choose-cards":
        await this.chooseCards(json, ws);
        break;
      case "choose-winner": 
        await this.chooseWinner(json, ws);
        break;
      case "dump-hand":
        await this.dumpHand(ws);
        break;
      case "reset-game": 
        const game = await this.getOrCreateGame(ws);
        await this.resetGame(ws, game, true);
        this.syncGame(game);
        break;
    } 
  }
  async handleInit(data, ws) {
    if(!data.user) return;
    ws.i = data.instance || "holy-shit";
    ws.deckName = data.deck || 'main';
    ws.debug = data.debug === true;
    ws.u = data.user;
    const game = await this.getOrCreateGame(ws);
    game.sockets[ws.u.id] = ws;
    if(game.players[ws.u.id]) {
      ws.player = game.players[ws.u.id];
      game.players[ws.u.id].connected = true;
      game.players[ws.u.id].disconnectTime = 0;
      if(game.players[ws.u.id].disconnectKickTimeout) {
        logger.info(`${ws.u.name} reconnected, cancelling kick timer.`);
        clearTimeout(game.players[ws.u.id].disconnectKickTimeout);
        game.players[ws.u.id].disconnectKickTimeout = null;
      }
    }
    this.syncGame(game);
    logger.info(`${ws.u.name} connected.`);
  }
  async removePlayer(ws) {
    const game = await this.getOrCreateGame(ws);
    if(game.players[ws.u.id]) {
      const player = game.players[ws.u.id];
      // Before removing the player, store their trophy count to be restored if they rejoin.
      if (!game.persistent_scores) game.persistent_scores = {};
      game.persistent_scores[ws.u.id] = player.trophies;
      if (!game.persistent_positions) game.persistent_positions = {};
      game.persistent_positions[ws.u.id] = player.position;

      if (player.disconnectKickTimeout) {
        clearTimeout(player.disconnectKickTimeout);
      }
      if (player.inactivityKickTimeout) {
        clearTimeout(player.inactivityKickTimeout);
      }
      if (player.cards) {
        game.whiteDiscard.push(...player.cards.filter(c => c));
      }
      if (player.selected) {
        game.whiteDiscard.push(...player.selected.filter(c => c));
      }
      const wasCzar = ws.u.id === game.czar;
      delete game.players[ws.u.id];
      if(Object.keys(game.players).length < 3 || wasCzar) {
        this.resetGame(ws, game);
        await this.startGame(ws);
      }else{
        this.syncGame(game);
      }
    }
  }
  async leaveGame(ws) {
    if(ws.player) {
      await this.removePlayer(ws);
    }
  }
  async resetGame(ws, game, hardReset) {
    const players = Object.keys(game.players);
    // Clear any active inactivity timers for all players
    players.forEach(playerId => {
      const player = game.players[playerId];
      if (player.inactivityKickTimeout) {
        clearTimeout(player.inactivityKickTimeout);
        player.inactivityKickTime = 0;
        player.inactivityKickTimeout = null;
      }
    });
    const allSelectedCards = players.flatMap(playerId => {
      const player = game.players[playerId];
      const selected = player.selected || [];
      player.selected = [];
      return selected;
    });
    game.whiteDiscard.push(...allSelectedCards.filter(c => c));
    game.currentPreviewResponse = 0;
    game.showBlack = false;
    game.winner = null;
    game.isStarted = false;
    if(hardReset) {
      logger.info(`Game instance "${ws.i}" is being hard-reset by ${ws.u.name} with deck: ${ws.deckName}`);
      const newDeck = await this.getDeck(ws.deckName);
      game.originalDeck = newDeck;
      game.czar = "";
      game.persistent_scores = {};
      game.persistent_positions = {};
      game.players = {};
      game.waitingRoom = [];
      game.blackDeck = game.originalDeck.black.slice().sort(() => Math.random() - 0.5);
      game.whiteDeck = game.originalDeck.white.slice().sort(() => Math.random() - 0.5);
      game.blackDiscard = [];
      game.whiteDiscard = [];
    }else{
      const currentCzarIndex = players.indexOf(game.czar);
      let nextCzarIndex = currentCzarIndex+1;
      if(nextCzarIndex > players.length - 1) {
        nextCzarIndex = 0;
      }
      game.czar = players[nextCzarIndex];
    }
  }
  async showBlack(ws) {
    const game = await this.getOrCreateGame(ws);
    if(ws.u.id === game.czar) {
      game.showBlack = true;

      // Clear the czar's inactivity timer since they've acted.
      const czarPlayer = game.players[game.czar];
      if (czarPlayer && czarPlayer.inactivityKickTimeout) {
        clearTimeout(czarPlayer.inactivityKickTimeout);
        czarPlayer.inactivityKickTime = 0;
        czarPlayer.inactivityKickTimeout = null;
      }

      // Now, set inactivity timers for all other players.
      const players = Object.keys(game.players);
      players.forEach(playerId => {
        if (playerId !== game.czar) {
          const player = game.players[playerId];
          player.inactivityKickTime = new Date().getTime() + (1000 * IDLE_TIMEOUT_SECONDS);
          player.inactivityKickTimeout = setTimeout(() => {
            if (game.players[playerId] && (!game.players[playerId].selected || game.players[playerId].selected.length === 0)) {
              logger.info(`Player ${player.name} kicked for game inactivity.`);
              this.removePlayer({ u: { id: playerId, name: player.name }, i: ws.i });
            }
          }, 1000 * IDLE_TIMEOUT_SECONDS);
        }
      });

      this.syncGame(game);
    }else{
      this.send(ws, "error", "Only the czar can show the black card.");
    } 
  }
  async chooseWinner(json, ws) {
    const game = await this.getOrCreateGame(ws);
    if(ws.u.id === game.czar) {
      // Clear the czar's inactivity timer since they've acted.
      const czarPlayer = game.players[game.czar];
      if (czarPlayer && czarPlayer.inactivityKickTimeout) {
        clearTimeout(czarPlayer.inactivityKickTimeout);
        czarPlayer.inactivityKickTime = 0;
        czarPlayer.inactivityKickTimeout = null;
      }

      game.players[json.data].trophies++;
      const {_id, trophies, cards, selected, name, position, connected, disconnectTime} = game.players[json.data];
      game.winner = {_id, trophies, cards, selected, name, position, connected, disconnectTime};
      this.syncGame(game);
      this.playSound(game, "fanfare%20with%20pop.ogg");
      setTimeout(async () => {
        this.resetGame(ws, game);
        await this.startGame(ws);
      }, 5000);
    }else{
      this.send(ws, "error", "Only the czar can choose a winner.");
    } 
  }

  _drawWhiteCard(game) {
    if (game.whiteDeck.length === 0) {
      if (game.whiteDiscard.length === 0) {
        logger.warn(`Game instance "${game.id}" ran out of white cards in both deck and discard. Reshuffling from original deck.`);

        // Get all card IDs currently in players' hands to avoid dealing duplicates.
        const cardsInHands = new Set(
          Object.values(game.players).flatMap(p => (p.cards || []).map(c => c._id))
        );

        // Filter the original deck to get only cards that are not currently in play.
        const availableCards = game.originalDeck.white.filter(c => !cardsInHands.has(c._id));

        if (availableCards.length === 0) {
          logger.error(`Game instance "${game.id}" has absolutely no white cards left to deal.`);
          return null;
        }

        game.whiteDeck = availableCards.slice().sort(() => Math.random() - 0.5);
        logger.info(`Re-shuffled ${game.whiteDeck.length} available original white cards for game "${game.id}".`);
      } else {
        logger.info(`Reshuffling white discard pile into deck for game "${game.id}".`);
        game.whiteDeck = game.whiteDiscard;
        game.whiteDiscard = [];
        // Shuffle the newly formed deck
        game.whiteDeck.sort(() => Math.random() - 0.5);
      }
    }
    return game.whiteDeck.pop();
  }

  _drawBlackCard(game) {
    if (game.blackDeck.length === 0) {
      if (game.blackDiscard.length === 0) {
        logger.warn(`Game instance "${game.id}" ran out of black cards. Reshuffling original deck.`);
        game.blackDeck = game.originalDeck.black.slice().sort(() => Math.random() - 0.5);
        game.blackDiscard = [];
        if (game.blackDeck.length === 0) return null; // Still no cards
      } else {
        logger.info(`Reshuffling black discard pile into deck for game "${game.id}".`);
        game.blackDeck = game.blackDiscard;
        game.blackDiscard = [];
        game.blackDeck.sort(() => Math.random() - 0.5);
      }
    }
    const card = game.blackDeck.pop();
    if (card) {
      // The drawn black card immediately goes to the discard pile
      game.blackDiscard.push(card);
    }
    return card;
  }
  
  async dumpHand(ws) {
    const game = await this.getOrCreateGame(ws);
    const player = game.players[ws.u.id];
    if (!player) {
      this.send(ws, "error", "You are not in the game.");
      return;
    }
    if (ws.u.id === game.czar) {
      this.send(ws, "error", "The czar cannot dump their hand.");
      return;
    }
    if (player.hasRequestedHandDumpThisRound) {
      this.send(ws, "error", "You can only request a new hand once per round.");
      return;
    }

    player.wantsNewHand = true;
    player.hasRequestedHandDumpThisRound = true;
    logger.info(`${player.name} has requested a new hand for the next round.`);
    
    this.syncGame(game);
  }
  async chooseCards(json, ws) {
    const game = await this.getOrCreateGame(ws);
    const player = game.players[ws.u.id];
    if (!player) return; // Player not in game, ignore.

    // Server-side validation to prevent multiple submissions in one round.
    if (player.selected && player.selected.length > 0) {
      this.send(ws, "error", "You have already submitted cards for this round.");
      return;
    }

    // Clear the inactivity timer for this player since they've acted.
    if (player.inactivityKickTimeout) {
      clearTimeout(player.inactivityKickTimeout);
      player.inactivityKickTime = 0;
    }

    const numResponses = game.currentBlackCard.numResponses || 1;
    // Expecting an array of card objects, each with a unique _id
    const submittedCards = (json.data || []).filter(d => d && d._id);

    if (submittedCards.length !== numResponses) {
      this.send(ws, "error", "Incorrect number of cards picked!");
      return;
    }

    const submittedCardIds = submittedCards.map(c => c._id);
    const playerCardIds = player.cards.map(c => c._id);

    // Verify the player actually has these cards in their hand
    const hasAllCards = submittedCardIds.every(id => playerCardIds.includes(id));

    if (hasAllCards) {
      // Move cards from hand to selected
      player.selected = submittedCards;
      // Replace submitted cards with null to keep their slots
      player.cards = player.cards.map(card => {
        if (card && submittedCardIds.includes(card._id)) {
          return null;
        }
        return card;
      });

      const playersInGame = Object.values(game.players);
      const nonCzarPlayers = playersInGame.filter(p => p._id !== game.czar);
      const allPlayersHaveChosen = nonCzarPlayers.every(p => p.selected && p.selected.length > 0);

      if (allPlayersHaveChosen) {
        logger.info(`All players have chosen. Starting inactivity timer for Czar: ${game.players[game.czar].name}`);
        // Clear timers for all non-czar players as their turn is over for this round.
        nonCzarPlayers.forEach(p => {
          if (p.inactivityKickTimeout) {
            clearTimeout(p.inactivityKickTimeout);
            p.inactivityKickTime = 0;
          }
        });

        // Set the timer for the Czar.
        const czarPlayer = game.players[game.czar];
        czarPlayer.inactivityKickTime = new Date().getTime() + (1000 * IDLE_TIMEOUT_SECONDS);
        czarPlayer.inactivityKickTimeout = setTimeout(() => {
          if (game.players[game.czar] && !game.winner) {
            logger.info(`Czar ${czarPlayer.name} kicked for inactivity.`);
            this.removePlayer({ u: { id: czarPlayer._id, name: czarPlayer.name }, i: ws.i });
          }
        }, 1000 * IDLE_TIMEOUT_SECONDS);
      }

      this.playSound(game, "card_flick.ogg");
      this.syncGame(game);
    } else {
      this.send(ws, "error", "Invalid card submission.");
      // Re-sync the client to correct their state if it's out of sync.
      this.syncGame(game, ws);
    }
  }
  async startGame(ws) {
    const game = await this.getOrCreateGame(ws);
    game.waitingRoom.forEach(d => { // d is the user object {id, name}
      const previousTrophies = (game.persistent_scores && game.persistent_scores[d.id]) || 0;

      const previousPosition = (game.persistent_positions && game.persistent_positions[d.id]);
      const occupiedPositions = new Set(Object.values(game.players).map(p => p.position));
      let positionToAssign;

      if (previousPosition !== undefined && !occupiedPositions.has(previousPosition)) {
        positionToAssign = previousPosition;
        delete game.persistent_positions[d.id];
      } else {
        positionToAssign = this.getPosition(game);
      }

      game.sockets[d.id].player = game.players[d.id] = {
        _id: d.id,
        trophies: previousTrophies,
        cards: [],
        selected: [],
        name: d.name,
        position: positionToAssign,
        connected: true,
        disconnectTime: 0,
        inactivityKickTime: 0,
        wantsNewHand: false,
        hasRequestedHandDumpThisRound: false,
        inactivityKickTimeout: null
      };
    });
    // Increment round number once per round
    game.round = (game.round || 0) + 1;
    game.waitingRoom = [];
    const players = Object.keys(game.players);
    if(players.length < 3) {
      this.syncGame(game); 
      this.playSound(game, "ding%20ding.ogg");
      return;
    }
    if(!game.czar){
      game.czar = players[0];
    }
    players.forEach(d => {
      const player = game.players[d];
      if (player.wantsNewHand) {
        logger.info(`Replacing hand for ${player.name}.`);
        if (player.cards && player.cards.length > 0) {
          game.whiteDiscard.push(...player.cards.filter(c => c));
        }
        player.cards = [];
        player.wantsNewHand = false;
      }
      player.hasRequestedHandDumpThisRound = false;
    });
    players.forEach(d => {
      const player = game.players[d];
      // First, fill in the null gaps from played cards
      for (let i = 0; i < player.cards.length; i++) {
        if (player.cards[i] === null) {
          const newCard = this._drawWhiteCard(game);
          if (newCard) {
            player.cards[i] = newCard;
          } else {
            // No more white cards to draw, stop trying to fill gaps
            break;
          }
        }
      }

      // Clean up any remaining nulls (in case we ran out of cards to deal)
      player.cards = player.cards.filter(c => c);

      // Then, top up the hand to the maximum size if needed
      while (player.cards.length < 12) {
        const newCard = this._drawWhiteCard(game);
        if (!newCard) break; // No more cards to draw
        player.cards.push(newCard);
      }
    });
    // Clear any previous timers for all players before starting a new round.
    players.forEach(playerId => {
      const player = game.players[playerId];
      if (player.inactivityKickTimeout) {
        clearTimeout(player.inactivityKickTimeout);
        player.inactivityKickTimeout = null;
        player.inactivityKickTime = 0;
      }
    });

    // Set inactivity timer for the Czar to reveal the black card.
    const czarPlayer = game.players[game.czar];
    if (czarPlayer) {
      czarPlayer.inactivityKickTime = new Date().getTime() + (1000 * IDLE_TIMEOUT_SECONDS);
      czarPlayer.inactivityKickTimeout = setTimeout(() => {
        if (game.players[game.czar] && !game.showBlack) {
          logger.info(`Czar ${czarPlayer.name} kicked for inactivity (did not show black card).`);
          this.removePlayer({ u: { id: czarPlayer._id, name: czarPlayer.name }, i: ws.i });
        }
      }, 1000 * IDLE_TIMEOUT_SECONDS);
    }
    game.currentBlackCard = this._drawBlackCard(game);
    game.isStarted = true;
    this.playSound(game, "gameStart.ogg");
    this.syncGame(game); 
  }
  async previewResponse(json, ws) {
    const game = await this.getOrCreateGame(ws);
    if(ws.u.id === game.czar) {
      game.currentPreviewResponse = json.data;
      this.playSound(game, "card_flick.ogg");
      this.syncGame(game);
    }else{
      this.send(ws, "error", "Only the czar can preview responses.");
    }
  } 
  async joinGame(json, ws) {
    const game = await this.getOrCreateGame(ws);
    if(Object.keys(game.players).length + game.waitingRoom.length > 9) {
      this.send(ws, "error", "This game is full, please try again later!");
      return;
    }

    // If a player is already in the game (active or waiting), ignore the join request.
    // This prevents them from being re-added, which would change their position and cause confusion.
    if (game.players[ws.u.id] || game.waitingRoom.some(p => p.id === ws.u.id)) {
      logger.info(`Player ${ws.u.name} (${ws.u.id}) tried to join but is already in the game. Syncing state instead.`);
      this.syncGame(game, ws);
      return; // Stop further processing
    }

    if(game.isStarted) {
      if(!game.waitingRoom.filter(d => d.id === ws.u.id).length) {
        game.waitingRoom.push(ws.u);
      }
    }else{      
      if(game.players[ws.u.id]) {
        clearTimeout(game.players[ws.u.id].disconnectKickTimeout);
      }
      const previousTrophies = (game.persistent_scores && game.persistent_scores[ws.u.id]) || 0;

      const previousPosition = (game.persistent_positions && game.persistent_positions[ws.u.id]);
      const occupiedPositions = new Set(Object.values(game.players).map(p => p.position));
      let positionToAssign;

      if (previousPosition !== undefined && !occupiedPositions.has(previousPosition)) {
        positionToAssign = previousPosition;
        delete game.persistent_positions[ws.u.id];
      } else {
        positionToAssign = this.getPosition(game);
      }

      ws.player = game.players[ws.u.id] = {
        _id: ws.u.id,
        trophies: previousTrophies,
        cards: [], 
        selected: [],
        name: ws.u.name,
        position: positionToAssign,
        connected:true,
        disconnectTime:0,
        inactivityKickTime: 0,
        wantsNewHand: false,
        hasRequestedHandDumpThisRound: false,
        inactivityKickTimeout: null
      };
    }
    this.playSound(game, "playerJoin.ogg");
    this.syncGame(game);
  } 
  playSound(game, sound) {
    Object.keys(game.sockets).forEach(socket => {
      this.send(game.sockets[socket], "play-sound", sound);
    });
  }
  async getDeck(deckNameOrUrl) {
    const deckIdentifier = deckNameOrUrl || 'main';
    logger.info(`Attempting to load deck: ${deckIdentifier}`);
    let cardIdCounter = 0;
    const processDeck = (deck) => {
      if (deck && Array.isArray(deck.black) && Array.isArray(deck.white)) {
        // Ensure cards are objects and assign a unique ID to each one.
        deck.black = deck.black.map(card => ({ ...(typeof card === 'string' ? { text: card } : card), _id: `b_${cardIdCounter++}` }));
        deck.white = deck.white.map(card => ({ ...(typeof card === 'string' ? { text: card } : card), _id: `w_${cardIdCounter++}` }));
        return deck;
      }
      return null;
    };
 
    try {
      let deckData;
      if (deckIdentifier.startsWith('http')) {
        logger.info(`Deck identifier "${deckIdentifier}" is a URL. Fetching...`);
        const response = await axios.get(deckIdentifier);
        deckData = response.data;
      } else {
        logger.info(`Deck identifier "${deckIdentifier}" is a local file name.`);
        // Sanitize to prevent path traversal and get the base name.
        const safeDeckName = path.basename(deckIdentifier);
        // Remove .json extension if it exists to avoid duplication, then re-add it.
        const baseName = safeDeckName.endsWith('.json') ? safeDeckName.slice(0, -5) : safeDeckName;
        const deckPath = path.join(__dirname, 'decks', `${baseName}.json`);
        logger.info(`Attempting to read local deck file from: ${deckPath}`);
        const fileContent = await fs.readFile(deckPath, 'utf8');
        deckData = JSON.parse(fileContent);
      }
 
      const processedDeck = processDeck(deckData);
      if (processedDeck) {
        logger.info(`Successfully loaded and processed deck: "${deckIdentifier}"`);
        return processedDeck;
      }
      throw new Error("Invalid deck format.");
    } catch (error) {
      logger.warn(`Failed to load deck "${deckIdentifier}". Error: ${error.message}`);
      if (error.code === 'ENOENT') {
        logger.warn(`The file was not found at the specified path. Please ensure the deck file exists.`);
      }
      if (error instanceof SyntaxError) {
        logger.warn(`This is likely a JSON syntax error in the deck file (e.g., a trailing comma). Please validate the file.`);
      }
      logger.warn(`Falling back to the main deck.`);
      const fallbackPath = path.join(__dirname, 'decks', 'main.json');
      logger.info(`Loading fallback deck from: ${fallbackPath}`);
      const fileContent = await fs.readFile(fallbackPath, 'utf8');
      const fallbackDeckData = JSON.parse(fileContent);
      return processDeck(fallbackDeckData);
    }
  }
  async getOrCreateGame(ws) {
    let game = this.games[ws.i];
    if(!game) {
      const deck = await this.getDeck(ws.deckName);
      game = this.games[ws.i] = {
        id: ws.i,
        players: {},
        persistent_positions: {},
        persistent_scores: {},
        waitingRoom: [],
        czar: null,
        currentBlackCard: null,
        currentPreviewResponse: 0,
        showBlack: false,
        originalDeck: deck,
        blackDeck: deck.black.slice().sort(() => Math.random() - 0.5),
        whiteDeck: deck.white.slice().sort(() => Math.random() - 0.5),
        blackDiscard: [],
        whiteDiscard: [],
        isStarted: false,
        winner: null,
        debug: ws.debug || false,
        sockets: {},
        round: 0
      }
    }
    return game;
  }
  getPosition(game) {
    const allPositions = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const occupiedPositions = new Set(Object.values(game.players).map(p => p.position));

    // This case should be handled by the game-full check, but it's good to be safe.
    if (occupiedPositions.size >= allPositions.length) {
      logger.error("Attempted to get a position in a full game.");
      return -1;
    }

    const availablePositions = allPositions.filter(p => !occupiedPositions.has(p));
    
    // Return a random position from the available ones.
    return availablePositions[Math.floor(Math.random() * availablePositions.length)];
  } 
  send(socket, path, data) {
     socket.send(JSON.stringify({path, data}));
  }
  syncGame(game, ws) {
    const { players, waitingRoom, czar, isStarted, currentBlackCard, showBlack, currentPreviewResponse, winner, debug } = game;
    const playerIds = Object.keys(players);
    const playerCount = playerIds.length;

    const createPayloadForPlayer = (targetPlayerId) => {
      const _players = {};
      playerIds.forEach(id => {
        const player = players[id];
        const { _id, trophies, selected, name, position, connected, disconnectTime, wantsNewHand, hasRequestedHandDumpThisRound, inactivityKickTime } = player;
        
        const publicPlayerView = { _id, trophies, selected, name, position, connected, disconnectTime, wantsNewHand, hasRequestedHandDumpThisRound, inactivityKickTime };

        // Reveal cards if it's the owner OR if debug mode is on.
        if (id === targetPlayerId || debug) {
          publicPlayerView.cards = player.cards;
        } else {
          publicPlayerView.cards = []; 
        }
        _players[id] = publicPlayerView;
      });

      return { 
        players: _players, 
        playerCount, 
        waitingRoom, 
        czar, 
        currentBlackCard, 
        isStarted, 
        showBlack, 
        currentPreviewResponse, 
        winner,
        config: { disconnectTimeout: DISCONNECT_TIMEOUT_SECONDS },
        round: game.round 
      };
    };

    if (ws) {
      this.send(ws, "sync-game", createPayloadForPlayer(ws.u.id));
    } else {
      Object.keys(game.sockets).forEach(socketId => {
        const targetSocket = game.sockets[socketId];
        if (targetSocket && targetSocket.u) {
          this.send(targetSocket, "sync-game", createPayloadForPlayer(targetSocket.u.id));
        }
      });
    }
  }
}
const gameServer = new GameServer();