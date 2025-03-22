const { Server } = require("socket.io")
const express = require("express")
const http = require("http")
const cors = require("cors")

const app = express()
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: "*", // In production, restrict this to your frontend URL
    methods: ["GET", "POST"],
  },
})

// Types (for documentation, not used in JS)
/**
 * @typedef {"rock" | "paper" | "scissors"} MoveType
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
 * @property {boolean} ready
 *
 * @typedef {Object} Game
 * @property {string} id
 * @property {Player[]} players
 * @property {string|null} currentTurn
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

// Process battle between two players
function processBattle(game, io) {
  const player1 = game.players[0]
  const player2 = game.players[1]

  // Process player 1's attack against player 2's defense
  const p1AttackType = player1.currentAttackType
  const p2DefenseType = player2.currentDefenseType
  const p1Effectiveness = getEffectivenessMultiplier(p1AttackType, p2DefenseType)
  const p1Damage = Math.max(
    5,
    Math.floor(player1.attack * p1Effectiveness.multiplier - player2.defense + Math.floor(Math.random() * 5)),
  )

  // Process player 2's attack against player 1's defense
  const p2AttackType = player2.currentAttackType
  const p1DefenseType = player1.currentDefenseType
  const p2Effectiveness = getEffectivenessMultiplier(p2AttackType, p1DefenseType)
  const p2Damage = Math.max(
    5,
    Math.floor(player2.attack * p2Effectiveness.multiplier - player1.defense + Math.floor(Math.random() * 5)),
  )

  // Apply damage
  player2.health = Math.max(0, player2.health - p1Damage)
  player1.health = Math.max(0, player1.health - p2Damage)

  // Update game log
  let effectivenessText1 = ""
  if (p1Effectiveness.type === "super") {
    effectivenessText1 = "It's super effective!"
  } else if (p1Effectiveness.type === "not") {
    effectivenessText1 = "It's not very effective..."
  }

  let effectivenessText2 = ""
  if (p2Effectiveness.type === "super") {
    effectivenessText2 = "It's super effective!"
  } else if (p2Effectiveness.type === "not") {
    effectivenessText2 = "It's not very effective..."
  }

  game.gameLog = [
    `${player1.name} attacks with ${p1AttackType} for ${p1Damage} damage! ${effectivenessText1}`,
    `${player2.name} attacks with ${p2AttackType} for ${p2Damage} damage! ${effectivenessText2}`,
    ...game.gameLog,
  ]

  // Send attack animations to clients
  io.to(game.id).emit("attack_animation", {
    attackerId: player1.id,
    defenderId: player2.id,
    attackType: p1AttackType,
    defenseType: p2DefenseType,
    effectiveness: p1Effectiveness.type,
  })

  // Delay second attack animation
  setTimeout(() => {
    io.to(game.id).emit("attack_animation", {
      attackerId: player2.id,
      defenderId: player1.id,
      attackType: p2AttackType,
      defenseType: p1DefenseType,
      effectiveness: p2Effectiveness.type,
    })
  }, 2000)

  // Check if game is over
  if (player1.health <= 0 || player2.health <= 0) {
    game.phase = "game_over"

    if (player1.health <= 0 && player2.health <= 0) {
      // Draw
      game.winner = null
      game.gameLog = ["The battle ended in a draw!", ...game.gameLog]
    } else if (player1.health <= 0) {
      // Player 2 wins
      game.winner = player2.id
      game.gameLog = [`${player2.name} wins the battle!`, ...game.gameLog]
    } else {
      // Player 1 wins
      game.winner = player1.id
      game.gameLog = [`${player1.name} wins the battle!`, ...game.gameLog]
    }

    // Notify clients about game over
    io.to(game.id).emit("game_over", {
      winnerId: game.winner,
    })
  } else {
    // Reset for next round
    player1.currentAttackType = null
    player1.currentDefenseType = null
    player1.ready = false

    player2.currentAttackType = null
    player2.currentDefenseType = null
    player2.ready = false

    game.phase = "selection"
    game.currentTurn = player1.id // First player goes first again
  }

  // Update game state for all clients after a delay
  setTimeout(() => {
    io.to(game.id).emit("game_state_update", game)
  }, 4000)
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
          currentDefenseType: null,
          ready: false,
        },
      ],
      currentTurn: null,
      phase: "waiting",
      winner: null,
      gameLog: ["Waiting for opponent to join..."],
    }

    // Join the socket to the game room
    socket.join(gameId)

    // Notify client that game was created
    socket.emit("game_joined", { gameId })

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
      currentDefenseType: null,
      ready: false,
    })

    // Join the socket to the game room
    socket.join(gameId)

    // Start the game
    game.phase = "selection"
    game.currentTurn = game.players[0].id // First player goes first
    game.gameLog = [`${playerName} joined the game. ${game.players[0].name} goes first!`]

    // Notify all clients in the room about the game state
    io.to(gameId).emit("game_state_update", game)

    // Notify the joining client that they joined successfully
    socket.emit("game_joined", { gameId })

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

  // Submit move
  socket.on("submit_move", ({ gameId, playerId, attackType, defenseType }) => {
    const game = games[gameId]

    if (!game) {
      socket.emit("error", { message: "Game not found" })
      return
    }

    const player = game.players.find((p) => p.id === playerId)

    if (!player) {
      socket.emit("error", { message: "Player not found in game" })
      return
    }

    if (game.currentTurn !== playerId) {
      socket.emit("error", { message: "Not your turn" })
      return
    }

    // Update player's move
    player.currentAttackType = attackType
    player.currentDefenseType = defenseType
    player.ready = true

    // Check if both players have submitted their moves
    const allPlayersReady = game.players.every((p) => p.ready)

    if (allPlayersReady) {
      // Process the battle
      processBattle(game, io)
    } else {
      // Switch turns
      game.currentTurn = game.players.find((p) => p.id !== playerId)?.id || null

      // Update game log
      game.gameLog = [`${player.name} has chosen their move. Waiting for opponent...`, ...game.gameLog]

      // Update game state for all clients
      io.to(gameId).emit("game_state_update", game)
    }
  })

  // Leave game
  socket.on("leave_game", ({ gameId, playerId }) => {
    const game = games[gameId]

    if (!game) return

    // Notify other player that this player left
    const otherPlayer = game.players.find((p) => p.id !== playerId)

    if (otherPlayer) {
      io.to(gameId).emit("game_state_update", {
        ...game,
        phase: "game_over",
        winner: otherPlayer.id,
        gameLog: [`${game.players.find((p) => p.id === playerId)?.name || "Opponent"} left the game.`, ...game.gameLog],
      })
    }

    // Remove the game after a delay
    setTimeout(() => {
      delete games[gameId]
    }, 5000)

    // Leave the socket room
    socket.leave(gameId)
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

