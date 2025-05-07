const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

const games = {};

function checkWinner(board) {
  const winPatterns = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];

  for (const pattern of winPatterns) {
    const [a, b, c] = pattern;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return board.includes(null) ? null : 'Tie';
}

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on('createGame', (username) => {
    try {
      const gameId = `game_${Math.random().toString(36).substring(2, 11)}`;
      const playerName = username || `Player_${Math.floor(Math.random() * 1000)}`;
      
      games[gameId] = {
        players: [{
          id: socket.id,
          username: playerName,
          symbol: 'X',
          disconnected: false
        }],
        board: Array(9).fill(null),
        currentPlayer: 'X',
        status: 'waiting'
      };
      
      socket.join(gameId);
      console.log(`Game created: ${gameId} by ${playerName}`);
      
      socket.emit('gameCreated', {
        success: true,
        gameId,
        username: playerName,
        board: games[gameId].board
      });
    } catch (error) {
      console.error('Error creating game:', error);
      socket.emit('gameCreated', {
        success: false,
        error: 'Failed to create game'
      });
    }
  });

  socket.on('joinGame', ({ gameId, username }) => {
    try {
      if (!games[gameId]) {
        return socket.emit('joinError', { error: 'Game not found. Please check the Game ID.' });
      }
      
      if (games[gameId].players.length >= 2) {
        return socket.emit('joinError', { error: 'Game is full. Please create a new game.' });
      }
      
      const playerName = username || `Player_${Math.floor(Math.random() * 1000)}`;
      const symbol = 'O';
      
      games[gameId].players.push({
        id: socket.id,
        username: playerName,
        symbol,
        disconnected: false
      });
      
      games[gameId].status = 'in-progress';
      socket.join(gameId);
      
      // Notify both players that game has started
      io.to(gameId).emit('gameStarted', {
        players: games[gameId].players,
        board: games[gameId].board,
        currentPlayer: games[gameId].currentPlayer,
        gameId
      });

      socket.emit('joinSuccess', { 
        symbol,
        gameId
      });
    } catch (error) {
      console.error('Error joining game:', error);
      socket.emit('joinError', { error: 'Failed to join game' });
    }
  });

  socket.on('makeMove', ({ gameId, cellIndex }) => {
    try {
      const game = games[gameId];
      if (!game) {
        return socket.emit('moveError', { error: 'Game not found' });
      }
      
      if (game.board[cellIndex] !== null) {
        return socket.emit('moveError', { error: 'Space already taken' });
      }
      
      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.symbol !== game.currentPlayer) {
        return socket.emit('moveError', { error: 'Not your turn' });
      }
      
      game.board[cellIndex] = game.currentPlayer;
      const winner = checkWinner(game.board);
      
      if (winner) {
        game.winner = winner;
      } else {
        game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
      }
      
      io.to(gameId).emit('moveMade', {
        board: game.board,
        winner: game.winner,
        currentPlayer: game.currentPlayer,
        gameId
      });
    } catch (error) {
      console.error('Error making move:', error);
      socket.emit('moveError', { error: 'Failed to make move' });
    }
  });

  socket.on('sendMessage', ({ gameId, message, sender, senderId }) => {
    try {
      const game = games[gameId];
      if (!game) return;
      
      const safeMessage = message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // Send to other player
      socket.broadcast.to(gameId).emit('messageReceived', {
        gameId,
        sender,
        senderId,
        message: safeMessage,
        timestamp: new Date().toLocaleTimeString()
      });
      // Send back to sender
      socket.emit('messageSent', {
        gameId,
        sender: 'You',
        senderId,
        message: safeMessage,
        timestamp: new Date().toLocaleTimeString()
      });
    } catch (error) {
      console.error('Error sending message:', error);
    }
  });

  socket.on('requestRematch', ({ gameId }, callback) => {
    try {
      const game = games[gameId];
      if (!game) {
        return callback({ error: 'Game not found' });
      }

      // Reset game state
      game.board = Array(9).fill(null);
      game.currentPlayer = 'X';
      game.winner = null;
      game.status = 'in-progress';

      // Notify both players
      io.to(gameId).emit('rematchAccepted', {
        board: game.board,
        currentPlayer: game.currentPlayer,
        gameId
      });

      callback({ success: true });
    } catch (error) {
      console.error('Error handling rematch:', error);
      callback({ error: 'Failed to process rematch' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    for (const gameId in games) {
      const game = games[gameId];
      const playerIndex = game?.players?.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        game.players.splice(playerIndex, 1);
        
        if (game.players.length > 0) {
          io.to(game.players[0].id).emit('playerLeft');
        } else {
          delete games[gameId];
        }
        break;
      }
    }
  });

  socket.on('leaveGame', ({ gameId }) => {
    const game = games[gameId];
    if (game) {
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        game.players.splice(playerIndex, 1);
        if (game.players.length > 0) {
          io.to(game.players[0].id).emit('playerLeft');
        } else {
          delete games[gameId];
        }
      }
    }
    socket.leave(gameId);
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});