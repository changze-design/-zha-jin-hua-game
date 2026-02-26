const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const { type, roomId, uid, nick, action, payload } = msg;
    if (!rooms[roomId]) {
      rooms[roomId] = {
        users: {},
        gameStart: false,
        pot: 0,
        firstPlayer: ''
      };
    }
    const room = rooms[roomId];
    switch (type) {
      case 'join':
        if (!room.users[uid]) {
          room.users[uid] = {
            nick, score: 1000, cards: [], isMing: false, fold: false
          };
        }
        broadcast(roomId, { type: 'sync', room });
        break;
      case 'action':
        handleAction(roomId, uid, action, payload, room, ws);
        break;
    }
  });
});

function handleAction(roomId, uid, action, payload, room, ws) {
  const base = 10;
  function getNum(s) {
    const m = {"A":14,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,"J":11,"Q":12,"K":13};
    return m[s.substring(1)] || 0;
  }
  function is235(c){const n=c.map(getNum).sort((a,b)=>a-b);return n[0]==2&&n[1]==3&&n[2]==5}
  function isBao(c){const n=c.map(getNum);return n[0]==n[1]&&n[1]==n[2]}
  function isTong(c){return c[0][0]==c[1][0]&&c[1][0]==c[2][0]}
  function isShun(c){const n=c.map(getNum).sort((a,b)=>a-b);return n[0]+1==n[1]&&n[1]+1==n[2]||(n[0]==2&&n[1]==3&&n[2]==14)}
  function isDui(c){const n=c.map(getNum).sort();return n[0]==n[1]||n[1]==n[2]}
  function level(c){
    if(is235(c))return 6;
    if(isBao(c))return 5;
    if(isTong(c)&&isShun(c))return 4;
    if(isTong(c))return 3;
    if(isShun(c))return 2;
    if(isDui(c))return 1;
    return 0;
  }
  function isWinner(a,b){
    const la=level(a),lb=level(b);
    const a235=is235(a),b235=is235(b);
    const abao=isBao(a),bbao=isBao(b);
    if(a235&&bbao)return true;
    if(b235&&abao)return false;
    if(la!=lb)return la>lb;
    const na=a.map(getNum).sort((x,y)=>y-x);
    const nb=b.map(getNum).sort((x,y)=>y-x);
    for(let i=0;i<3;i++)if(na[i]!=nb[i])return na[i]>nb[i];
    return false;
  }
  function newDeck() {
    const d = [];
    const cs = ["♠","♥","♣","♦"];
    const ns = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
    cs.forEach(c => ns.forEach(n => d.push(c+n)));
    for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
    return d;
  }
  function checkGameOver(roomId, room) {
    const alive = Object.keys(room.users).filter(u => !room.users[u].fold);
    if (alive.length !== 1) return;
    const win = alive[0];
    room.users[win].score += room.pot;
    room.gameStart = false;
    room.firstPlayer = win;
    broadcast(roomId, { type: 'gameOver', winner: room.users[win].nick, pot: room.pot });
    broadcast(roomId, { type: 'sync', room });
  }
  switch (action) {
    case 'start':
      const uids = Object.keys(room.users);
      if (uids.length < 3 || uids.length > 5) {
        ws.send(JSON.stringify({ type: 'tip', msg: '3-5人才能开始' }));
        return;
      }
      if (room.gameStart) return;
      room.gameStart = true;
      room.pot = 0;
      const deck = newDeck();
      if (!room.firstPlayer || !room.users[room.firstPlayer]) room.firstPlayer = uids[0];
      uids.forEach(u => { room.users[u].cards = []; room.users[u].isMing = false; room.users[u].fold = false; });
      const order = [];
      let at = uids.indexOf(room.firstPlayer);
      for (let i = 0; i < uids.length; i++) order.push(uids[(at + i) % uids.length]);
      for (let t = 0; t < 3; t++) order.forEach(u => room.users[u].cards.push(deck.pop()));
      order.forEach(u => { room.users[u].score -= base; room.pot += base; });
      broadcast(roomId, { type: 'sync', room });
      broadcast(roomId, { type: 'tip', msg: '已洗牌发牌！' });
      break;
    case 'look':
      if (!room.gameStart || !room.users[uid] || room.users[uid].fold) return;
      room.users[uid].isMing = true;
      broadcast(roomId, { type: 'sync', room });
      broadcast(roomId, { type: 'tip', msg: `${room.users[uid].nick} 已看牌` });
      break;
    case 'men':
      if (!room.gameStart || !room.users[uid] || room.users[uid].fold || room.users[uid].isMing) {
        ws.send(JSON.stringify({ type: 'tip', msg: '不能闷牌' }));
        return;
      }
      if (room.users[uid].score < base) { ws.send(JSON.stringify({ type: 'tip', msg: '积分不足' })); return; }
      room.users[uid].score -= base; room.pot += base;
      broadcast(roomId, { type: 'sync', room });
      broadcast(roomId, { type: 'tip', msg: `${room.users[uid].nick} 闷牌下注` });
      break;
    case 'fold':
      if (!room.gameStart || !room.users[uid] || room.users[uid].fold) return;
      room.users[uid].fold = true;
      broadcast(roomId, { type: 'sync', room });
      broadcast(roomId, { type: 'tip', msg: `${room.users[uid].nick} 弃牌` });
      checkGameOver(roomId, room);
      break;
    case 'bi':
      if (!room.gameStart || !room.users[uid] || room.users[uid].fold) return;
      const me = room.users[uid];
      const targets = Object.keys(room.users).filter(u => u !== uid && !room.users[u].fold);
      if (!targets.length) { ws.send(JSON.stringify({ type: 'tip', msg: '无可比牌对象' })); return; }
      const t = targets[0];
      const foe = room.users[t];
      if (me.isMing && !foe.isMing) { ws.send(JSON.stringify({ type: 'tip', msg: '明不能开闷' })); return; }
      const win = isWinner(me.cards, foe.cards);
      if (win) { room.users[t].fold = true; broadcast(roomId, { type: 'tip', msg: `${me.nick} 赢 ${foe.nick}` }); }
      else { room.users[uid].fold = true; broadcast(roomId, { type: 'tip', msg: `${me.nick} 输 ${foe.nick}` }); }
      broadcast(roomId, { type: 'sync', room });
      checkGameOver(roomId, room);
      break;
    case 'giveTo':
      const { targetUid, num } = payload;
      if (room.users[targetUid]) {
        room.users[targetUid].score += num;
        broadcast(roomId, { type: 'sync', room });
        broadcast(roomId, { type: 'tip', msg: `给 ${room.users[targetUid].nick} +${num}` });
      } else {
        ws.send(JSON.stringify({ type: 'tip', msg: '未找到玩家' }));
      }
      break;
    case 'giveAll':
      const numAll = payload.num || 1000;
      Object.keys(room.users).forEach(u => room.users[u].score += numAll);
      broadcast(roomId, { type: 'sync', room });
      broadcast(roomId, { type: 'tip', msg: `全员 +${numAll}` });
      break;
    case 'resetAll':
      Object.keys(room.users).forEach(u => room.users[u].score = 1000);
      broadcast(roomId, { type: 'sync', room });
      broadcast(roomId, { type: 'tip', msg: '全员重置1000' });
      break;
  }
}

function broadcast(roomId, data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`运行在端口 ${PORT}`);
});
