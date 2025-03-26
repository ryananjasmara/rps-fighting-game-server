const { Server } = require("socket.io")
const express = require("express")
const http = require("http")
const cors = require("cors")

const app = express()
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: "https://v0-rps-fighting-game.vercel.app/", // In production, restrict this to your frontend URL
    methods: ["GET", "POST"],
  },
})

// Types (for documentation, not used in JS)
/**
 * @typedef {"rock" | "paper" | "scissors"} MoveType
 * @typedef {"attack" | "defend"} TurnType
 *
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} name
 * @property {number} health
 * @property {number} maxHealth
 * @property {number} attack
 * @property {number} defense
 * @property {MoveType|null} currentAttackType
 * @property {MoveType|null} currentDefenseType
 *
 * @typedef {Object} Game
 * @property {string} id
 * @property {Player[]} players
 * @property {string|null} currentTurn
 * @property {TurnType} currentTurnType
 * @property {Object|null} pendingAttack
 * @property {"waiting" | "selection" | "battle" | "game_over"} phase
 * @property {string|null} winner
 * @property {string[]} gameLog
 */

// In-memory storage for games
const games = {}

// Effectiveness multipliers
const SUPER_EFFECTIVE = 2.0
const NORMAL_EFFECTIVE = 1.0
const NOT_EFFECTIVE = 0.5

// Turn types
const TURN_TYPE = {
  ATTACK: "attack",
  DEFEND: "defend"
}

// Function to broadcast available games to all clients
function broadcastAvailableGames() {
  const availableGames = Object.values(games)
    .filter((game) => game.phase === "waiting" && game.players.length < 2)
    .map((game) => ({
      id: game.id,
      host: game.players[0].name,
      players: game.players.length,
    }));

  io.emit("available_games", { games: availableGames });
}

// Calculate effectiveness multiplier based on attack and defense types
const getEffectivenessMultiplier = (attackType, defenseType) => {
  if (
    (attackType === "rock" && defenseType === "scissors") ||
    (attackType === "scissors" && defenseType === "paper") ||
    (attackType === "paper" && defenseType === "rock")
  ) {
    return { multiplier: SUPER_EFFECTIVE, type: "super" }
  } else if (attackType === defenseType) {
    return { multiplier: NORMAL_EFFECTIVE, type: "normal" }
  } else {
    return { multiplier: NOT_EFFECTIVE, type: "not" }
  }
}

// Generate a unique game ID
const generateGameId = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id)

  // Create a new game
  socket.on("create_game", ({ playerId, playerName }) => {
    const gameId = generateGameId()

    games[gameId] = {
      id: gameId,
      players: [
        {
          id: playerId,
          name: playerName,
          health: 100,
          maxHealth: 100,
          attack: 15,
          defense: 5,
          currentAttackType: null,
          currentDefenseType: null
        },
      ],
      currentTurn: null,
      currentTurnType: TURN_TYPE.ATTACK, // Default to attack for the first turn
      pendingAttack: null,
      phase: "waiting",
      winner: null,
      gameLog: ["Waiting for opponent to join..."],
    }

    // Join the socket to the game room
    socket.join(gameId)

    // Notify client that game was created
    socket.emit("game_joined", { gameId })

    broadcastAvailableGames()

    console.log(`Game created: ${gameId} by player ${playerName} (${playerId})`)
  })

  // Join an existing game
  socket.on("join_game", ({ gameId, playerId, playerName }) => {
    const game = games[gameId]

    if (!game) {
      socket.emit("error", { message: "Game not found" })
      return
    }

    if (game.players.length >= 2) {
      socket.emit("error", { message: "Game is full" })
      return
    }

    // Add player to the game
    game.players.push({
      id: playerId,
      name: playerName,
      health: 100,
      maxHealth: 100,
      attack: 15,
      defense: 5,
      currentAttackType: null,
      currentDefenseType: null
    })

    // Join the socket to the game room
    socket.join(gameId)

    // Start the game
    game.phase = "selection"  // Change game phase
    game.currentTurn = game.players[0].id // First player goes first
    game.currentTurnType = TURN_TYPE.ATTACK // First player attacks
    game.pendingAttack = null
    game.gameLog = [`${playerName} joined the game. ${game.players[0].name} goes first with an attack!`]

    // Emit game state update to all clients BEFORE emitting game_joined
    setTimeout(() => {
      io.to(gameId).emit("game_state_update", {
        ...game,
        phase: "selection"  // Ensure game phase is sent correctly
      })
    }, 500)

    // Notify the joining client that they joined successfully
    socket.emit("game_joined", {
      gameId,
      gameState: game  // Send latest game state to newly joined client
    })

    broadcastAvailableGames()

    console.log(`Player ${playerName} (${playerId}) joined game ${gameId}`)
  })

  // Get available games
  socket.on("get_available_games", () => {
    const availableGames = Object.values(games)
      .filter((game) => game.phase === "waiting" && game.players.length < 2)
      .map((game) => ({
        id: game.id,
        host: game.players[0].name,
        players: game.players.length,
      }))

    socket.emit("available_games", { games: availableGames })
  })

  // Submit attack
  socket.on("submit_attack", ({ gameId, playerId, attackType }) => {
    const game = games[gameId]

    if (!game) {
      socket.emit("error", { message: "Game not found" })
      return
    }

    const player = game.players.find(p => p.id === playerId)

    if (!player) {
      socket.emit("error", { message: "Player not found in game" })
      return
    }

    if (game.currentTurn !== playerId || game.currentTurnType !== TURN_TYPE.ATTACK) {
      socket.emit("error", { message: "Not your turn to attack" })
      return
    }

    // Store the pending attack
    player.currentAttackType = attackType
    game.pendingAttack = { playerId, attackType }

    // Change turn to other player for defense
    const defender = game.players.find(p => p.id !== playerId)
    game.currentTurn = defender.id
    game.currentTurnType = TURN_TYPE.DEFEND

    // Update game log
    game.gameLog = [`${player.name} chose ${attackType} attack. ${defender.name} must choose a defense.`, ...game.gameLog]

    // Update game state for all clients
    io.to(gameId).emit("game_state_update", game)
  })

  // Submit defense
  socket.on("submit_defense", ({ gameId, playerId, defenseType }) => {
    const game = games[gameId]

    if (!game) {
      socket.emit("error", { message: "Game not found" })
      return
    }

    const defender = game.players.find(p => p.id === playerId)

    if (!defender) {
      socket.emit("error", { message: "Player not found in game" })
      return
    }

    const attackerId = game.pendingAttack.playerId
    const attackType = game.pendingAttack.attackType
    const attacker = game.players.find(p => p.id === attackerId)

    // Store defense type
    defender.currentDefenseType = defenseType

    // Calculate effectiveness and damage
    const { multiplier, type } = getEffectivenessMultiplier(attackType, defenseType)
    const damage = Math.max(5, Math.floor(attacker.attack * multiplier - defender.defense + Math.floor(Math.random() * 5)))

    // Reduce defender's health
    defender.health = Math.max(0, defender.health - damage)

    // Update game log
    let effectivenessText = ""
    if (type === "super") {
      effectivenessText = "It's super effective!"
    } else if (type === "not") {
      effectivenessText = "It's not very effective..."
    }

    game.gameLog = [
      `${defender.name} defended with ${defenseType}.`,
      `${attacker.name}'s ${attackType} attack dealt ${damage} damage! ${effectivenessText}`,
      ...game.gameLog
    ]

    // Kirim animasi serangan
    io.to(gameId).emit("attack_animation", {
      attackerId: attacker.id,
      defenderId: defender.id,
      attackType,
      defenseType,
      effectiveness: type
    })

    // Check if game is over
    if (defender.health <= 0) {
      game.phase = "game_over"
      game.winner = attacker.id
      game.gameLog = [`${attacker.name} wins the battle!`, ...game.gameLog]

      // Send game over notification
      io.to(gameId).emit("game_over", {
        winnerId: attacker.id
      })

      // Update game state for all clients after delay
      setTimeout(() => {
        io.to(gameId).emit("game_state_update", game)
      }, 2000)
    } else {
      // Change turn - now defender becomes attacker
      game.currentTurn = defender.id
      game.currentTurnType = TURN_TYPE.ATTACK
      game.pendingAttack = null

      // Update game state for all clients after delay
      setTimeout(() => {
        io.to(gameId).emit("game_state_update", game)
      }, 2000)
    }
  })

  // Leave game
  socket.on("leave_game", ({ gameId, playerId }) => {
    const game = games[gameId]

    if (!game) return

    // Remove the player from the game's players array
    game.players = game.players.filter(p => p.id !== playerId)

    // If there are still other players, notify them
    if (game.players.length > 0) {
      const otherPlayer = game.players[0]
      io.to(gameId).emit("game_state_update", {
        ...game,
        phase: "game_over",
        winner: otherPlayer.id,
        gameLog: [`${game.players.find((p) => p.id === playerId)?.name || "Opponent"} left the game.`, ...game.gameLog],
      })

      // Remove the game after a delay if there are other players
      setTimeout(() => {
        delete games[gameId]
      }, 5000)
    } else {
      // If no players left, remove the game immediately
      delete games[gameId]
    }

    // Leave the socket room
    socket.leave(gameId)

    broadcastAvailableGames()
  })

  // Disconnect
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id)
  })
})

// Add a simple health check route
app.get("/", (req, res) => {
  res.send("Socket.io server is running")
})

const PORT = process.env.PORT || 3001

server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`)
})
