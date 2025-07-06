const { WebSocket } = require('@encharm/cws');
const express = require('express');
const http = require('http');
const path = require('path');
const deck = require("./deck");

class GameServer{
  constructor() {
    console.log("game starting...");
    this.setupServer();
    this.games = {}
  }
  setupServer() {  
    
    this.app = express();
    
    this.server = http.createServer( this.app );
    
    this.wss = new WebSocket.Server({ noServer: true });
    
    this.server.on('upgrade', (request, socket, head) => {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      }); 
    }); 
     
    this.wss.startAutoPing(10000);
    
    this.wss.on('connection', (ws, req) => {
    //  ws.send({path: 'initial-state', data: this.room.data});
      ws.on('message', msg => {
        try{
          if(msg !== "keepalive") {
            this.parseMessage(msg, ws); 
          }
        }catch(e) {
          console.log("parse error: ", e);
        }
      });
      ws.on('close', (code, reason) => {
        this.handleClose(ws);
      });
    });
    
    this.app.use(express.static(path.join(__dirname, 'public')));

    this.server.listen( 3000, function listening(){
        console.log("game started");
    });
  }
  handleClose(ws) { 
    const name = ws.u ? ws.u.name : 'Unknown';
    console.log(name, 'disconnected.');
    Object.keys(this.games).forEach(key => {
      const game = this.games[key];
      if(ws.u && game.players[ws.u.id]) {
        game.players[ws.u.id].connected = false;
        game.players[ws.u.id].disconnectTime = new Date().getTime();
        console.log("Kicking in 2 mins...")
        game.players[ws.u.id].kickTimeout = setTimeout(()=>{
          if(!game.players[ws.u.id] || !game.players[ws.u.id].connected) {
            console.log(name, "kicked for inactivity.")
            this.removePlayer(ws);
          }
        }, 1000 * 45);
        this.syncGame(game);
      }
      if(ws.u && game.waitingRoom.map(d => d.id).indexOf(ws.u.id) > -1) { 
        console.log(".. removed from waiting list.");
        game.waitingRoom = game.waitingRoom.filter(d => d.id !== ws.u.id);
      }
    }); 
  } 
  parseMessage(msg, ws) {
    let json = JSON.parse(msg);
    switch(json.path) {
      case "init":
        if(json.data.user) {
          ws.i = json.data.instance || "holy-shit";
          ws.u = json.data.user;
          const game = this.getOrCreateGame(ws);
          game.sockets[ws.u.id] = ws;
          if(game.players[ws.u.id]) {
            ws.player = game.players[ws.u.id];
            const name = ws.u ? ws.u.name : 'Unknown';
            game.players[ws.u.id].connected = true;
            game.players[ws.u.id].disconnectTime = 0;
            if(game.players[ws.u.id].kickTimeout) {
              console.log(name, "returned within 2 mins, not kicked.")
              clearTimeout(game.players[ws.u.id].kickTimeout);
              game.players[ws.u.id].kickTimeout = null;
            }
          }
          this.syncGame(game);
          console.log(ws.u ? ws.u.name : 'Unknown', 'connected.');
        }
        break;
      case "join-game":
        this.joinGame(this.getOrCreateGame(ws), json, ws);
        break;
      case "start-game":
        this.startGame(ws);
        break;
      case "leave-game":
        this.leaveGame(ws);
        break;
      case "show-black":
        this.showBlack(ws);
        break; 
      case "preview-response":
        this.previewResponse(json, ws);
        break; 
      case "choose-cards":
        this.chooseCards(json, ws);
        break;
      case "choose-winner": 
        this.chooseWinner(json, ws);
        break;
      case "reset-game": 
        const game = this.getOrCreateGame(ws);
        this.resetGame(ws, game, true);
        this.syncGame(game);
        break;
    } 
  }
  removePlayer(ws, player) {
    const game = this.getOrCreateGame(ws);
    if(game.players[ws.u.id]) {
      const wasCzar = ws.u.id === game.czar;
      delete game.players[ws.u.id];
      if(Object.keys(game.players).length < 3 || wasCzar) {
        this.resetGame(ws, game);
        this.startGame(ws);
      }else{
        this.syncGame(game);
      }
    }
  }
  leaveGame(ws) {
    if(ws.player) {
      this.removePlayer(ws, ws.player);
    }
  }
  resetGame(ws, game, hardReset) {
    const players = Object.keys(game.players);
    players.forEach(card => {
      game.players[card].cards = game.players[card].cards.filter(d => game.players[card].selected.map(s => s.text).indexOf(d.text) === -1);
      game.white = [...game.players[card].selected, ...game.white];
      game.players[card].selected = [];
    })
    game.currentPreviewResponse = 0;
    game.showBlack = false;
    game.winner = null;
    game.isStarted = false;
    if(hardReset) {
      game.czar = ""
      game.players = {};
      game.waitingRoom = [];
      game.black = deck.black.slice().sort(() => Math.random() - 0.5);
      game.white = deck.white.slice().sort(() => Math.random() - 0.5);
    }else{
      const currentCzarIndex = players.indexOf(game.czar);
      let nextCzarIndex = currentCzarIndex+1;
      if(nextCzarIndex > players.length - 1) {
        nextCzarIndex = 0;
      }
      game.white.sort(() => Math.random() - 0.5);
      game.black.sort(() => Math.random() - 0.5);
      game.czar = players[nextCzarIndex];
    }
  }
  showBlack(ws) {
    const game = this.getOrCreateGame(ws);
    if(ws.u.id === game.czar) {
      game.showBlack = true;
      this.syncGame(game);
    }else{
      this.send(ws, "error", "Only the czar can show the black card.");
    } 
  }
  chooseWinner(json, ws) {
    const game = this.getOrCreateGame(ws);
    if(ws.u.id === game.czar) {
      game.players[json.data].trophies++;
      const {_id, trophies, cards, selected, name, position, connected, disconnectTime} = game.players[json.data];
      game.winner = {_id, trophies, cards, selected, name, position, connected, disconnectTime};
      this.syncGame(game);
      this.playSound(game, "fanfare%20with%20pop.ogg");
      setTimeout(() => {
        this.resetGame(ws, game);
        this.startGame(ws);
      }, 5000);
    }else{
      this.send(ws, "error", "Only the czar can choose a winner.");
    } 
  }  
  chooseCards(json, ws) {
    const game = this.getOrCreateGame(ws);
    const numResponses = game.currentBlackCard.numResponses || 1;
    json.data = json.data.filter(d => d);
    if(json.data.length === numResponses) {
      game.players[ws.u.id].selected = json.data;
      this.playSound(game, "card_flick.ogg");
      this.syncGame(game);
    }else{
      this.send(ws, "error", "Not enough cards picked!");
    }
  }
  startGame(ws) {
    const game = this.getOrCreateGame(ws);
    game.waitingRoom.forEach(d => {
      game.sockets[d.id].player = game.players[d.id] = {
        _id: d.id,
        trophies: 0, 
        cards: [], 
        selected: [],
        name: d.name,
        position: this.getPosition(game),
        connected:true,
        disconnectTime:0
      }
    })
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
      if(player.cards.length < 12) {
        for(let i = player.cards.length; i < 12; i++ ) {
          const card = game.white.pop();
          player.cards.push(game.white.pop(card));
        }
      }
      player.cards.length = 12;
    }); 
    game.currentBlackCard = game.black.pop(); 
    game.isStarted = true;
    this.playSound(game, "gameStart.ogg");
    this.syncGame(game); 
  }
  previewResponse(json, ws) {
    const game = this.getOrCreateGame(ws);
    if(ws.u.id === game.czar) {
      game.currentPreviewResponse = json.data;
      this.playSound(game, "card_flick.ogg");
      this.syncGame(game);
    }else{
      this.send(ws, "error", "Only the czar can preview responses.");
    }
  } 
  joinGame(game, json, ws) {
    if(Object.keys(game.players).length + game.waitingRoom.length > 9) {
      this.send(ws, "error", "This game is full, please try again later!");
      return;
    }
    if(game.isStarted) {
      if(!game.waitingRoom.filter(d => d.id === ws.u.id).length) {
        game.waitingRoom.push(ws.u);
      }
    }else{      
      if(game.players[ws.u.id]) {
        clearTimeout(game.players[ws.u.id].kickTimeout);
      }
      ws.player = game.players[ws.u.id] = {
        _id: ws.u.id,
        trophies: 0, 
        cards: [], 
        selected: [],
        name: ws.u.name,
        position: this.getPosition(game),
        connected:true,
        disconnectTime:0
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
  getOrCreateGame(ws) {
    let game = this.games[ws.i];
    if(!game) {
      game = this.games[ws.i] = {
        players: {},
        waitingRoom: [],
        czar: null,
        currentBlackCard: null,
        currentPreviewResponse: 0,
        showBlack: false,
        black: deck.black.slice().sort(() => Math.random() - 0.5),
        white: deck.white.slice().sort(() => Math.random() - 0.5),
        isStarted: false,
        winner: null,
        sockets: {}
      }
    }
    return game;
  }
  getPosition(game) {
    const position = Math.floor(Math.random() * 10);
    if(Object.keys(game.players).map(d => game.players[d].position).indexOf(position) > -1) {
      return this.getPosition(game);
    }else{
      return position;
    }
  } 
  send(socket, path, data) {
     socket.send(JSON.stringify({path, data}));
  }
  syncGame(game, ws) {
    const {players, waitingRoom, czar, isStarted, currentBlackCard, showBlack, currentPreviewResponse, winner} = game;
    
    const playerIds = Object.keys(players);
    
    const _players = playerIds.map(d => {
      const {_id, trophies, cards, selected, name, position, connected, disconnectTime} = players[d];
      return {_id, trophies, cards, selected, name, position, connected, disconnectTime};
    }).reduce((a,b) => {
      a[b._id] = b;
      return a;
    }, {});
    
    const playerCount = playerIds.length;
    if(ws) {
      this.send(ws, "sync-game", {players: _players, playerCount, waitingRoom, czar, currentBlackCard, isStarted, showBlack, currentPreviewResponse, winner});
    }else{
      Object.keys(game.sockets).forEach(socket => {
        this.send(game.sockets[socket], "sync-game", {players: _players, playerCount, waitingRoom, czar, currentBlackCard, isStarted, showBlack, currentPreviewResponse, winner});
      });
    }
  }
}
const gameServer = new GameServer();