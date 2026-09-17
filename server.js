const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Conexión directa y segura usando la URL completa de Railway
const pool = mysql.createPool(process.env.DATABASE_URL || {
    host: process.env.MYSQLHOST || 'localhost',
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: process.env.MYSQLDATABASE || 'railway',
    port: process.env.MYSQLPORT || 3306,
    ssl: { rejectUnauthorized: false }
});

const db = pool.promise();

// Inicializar tablas automáticamente al arrancar
async function inicializarBaseDatos() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                balance DECIMAL(12, 2) DEFAULT 0.00,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS bets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                amount DECIMAL(12, 2) NOT NULL,
                payout DECIMAL(12, 2) NOT NULL,
                result ENUM('win', 'lose') NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                type ENUM('deposit', 'withdrawal') NOT NULL,
                amount DECIMAL(12, 2) NOT NULL,
                method VARCHAR(50) NOT NULL,
                destination VARCHAR(255) NOT NULL,
                status ENUM('pending', 'completed', 'rejected') DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
        `);
        console.log("Tablas de la base de datos verificadas y listas.");
    } catch (err) {
        console.error("Error crítico creando tablas:", err.message);
    }
}

// Registro
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Faltan datos en el formulario' });
        }

        const hash = await bcrypt.hash(password, 10);
        const [result] = await db.query(
            'INSERT INTO users (username, password_hash, balance) VALUES (?, ?, 0.00)', 
            [username, hash]
        );
        
        res.json({ message: 'Usuario creado con éxito', userId: result.insertId });
    } catch (e) {
        console.error("Error detallado en registro:", e.message);
        if (e.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'El nombre de usuario ya está en uso' });
        }
        res.status(400).json({ error: 'Error al registrar: ' + e.message });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Completa todos los campos' });
        }

        const [results] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        if (results.length === 0) {
            return res.status(400).json({ error: 'Usuario no encontrado' });
        }

        const user = results[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(400).json({ error: 'Contraseña incorrecta' });
        }

        res.json({ user: { id: user.id, username: user.username, balance: parseFloat(user.balance) } });
    } catch (e) {
        console.error("Error en login:", e.message);
        res.status(400).json({ error: 'Error al iniciar sesión: ' + e.message });
    }
});

// Procesar Apuesta
app.post('/api/play', async (req, res) => {
    try {
        const { userId, betAmount, game, choice } = req.body;
        if (!betAmount || betAmount <= 0) return res.status(400).json({ error: 'Apuesta no válida' });

        const [users] = await db.query('SELECT balance FROM users WHERE id = ?', [userId]);
        if (users.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

        const balance = parseFloat(users[0].balance);
        if (balance < betAmount) return res.status(400).json({ error: 'Fondos insuficientes' });

        let win = false;
        let payout = 0;
        let outcomeMsg = '';

        if (game === 'coinflip') {
            const outcome = Math.random() < 0.5 ? 'cara' : 'cruz';
            win = (choice === outcome);
            payout = win ? betAmount * 2 : 0;
            outcomeMsg = outcome;
        } else if (game === 'roulette') {
            const rand = Math.random() * 14;
            let outcome = 'negro';
            if (rand < 1) outcome = 'verde';
            else if (rand < 7.5) outcome = 'rojo';

            win = (choice === outcome);
            const multiplier = (outcome === 'verde') ? 14 : 2;
            payout = win ? betAmount * multiplier : 0;
            outcomeMsg = outcome;
        }

        const newBalance = balance - betAmount + payout;
        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();
            await connection.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
            await connection.query(
                'INSERT INTO bets (user_id, amount, payout, result) VALUES (?, ?, ?, ?)', 
                [userId, betAmount, payout, win ? 'win' : 'lose']
            );
            await connection.commit();
            connection.release();

            res.json({ win, payout, newBalance, outcome: outcomeMsg });
        } catch (txErr) {
            await connection.rollback();
            connection.release();
            throw txErr;
        }
    } catch (e) {
        console.error("Error en juego:", e.message);
        res.status(500).json({ error: 'Error al procesar la apuesta' });
    }
});

// Retirar
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, amount, method, account } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto inválido' });

        const [users] = await db.query('SELECT balance FROM users WHERE id = ?', [userId]);
        if (users.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

        const balance = parseFloat(users[0].balance);
        if (balance < amount) return res.status(400).json({ error: 'Saldo insuficiente' });

        const newBalance = balance - amount;
        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();
            await connection.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
            await connection.query(
                'INSERT INTO transactions (user_id, type, amount, method, destination, status) VALUES (?, "withdrawal", ?, ?, ?, "pending")', 
                [userId, amount, method, account]
            );
            await connection.commit();
            connection.release();

            res.json({ message: 'Solicitud de retiro creada', newBalance });
        } catch (txErr) {
            await connection.rollback();
            connection.release();
            throw txErr;
        }
    } catch (e) {
        console.error("Error en retiro:", e.message);
        res.status(500).json({ error: 'Error al procesar el retiro' });
    }
});

const PORT = process.env.PORT || 3000;
inicializarBaseDatos().then(() => {
    app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
});
