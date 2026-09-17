const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Conexión segura a la Base de Datos en la Nube (Railway / Aiven / Render)
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'real_casino',
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false }
});

db.connect(err => {
    if (err) console.error("Error conectando a la Base de Datos:", err);
    else console.log("Conectado a la Base de Datos de Dinero Real.");
});

// Registro de Usuario Real
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });

    try {
        const hash = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, password_hash, balance) VALUES (?, ?, 0.00)', [username, hash], (err, result) => {
            if (err) return res.status(400).json({ error: 'El usuario ya existe' });
            res.json({ message: 'Usuario creado con éxito', userId: result.insertId });
        });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Inicio de Sesión Real
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err || results.length === 0) return res.status(400).json({ error: 'Usuario no encontrado' });

        const user = results[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(400).json({ error: 'Contraseña incorrecta' });

        res.json({ user: { id: user.id, username: user.username, balance: parseFloat(user.balance) } });
    });
});

// Procesar Apuesta con Dinero Real (Servidor controla el resultado)
app.post('/api/play', (req, res) => {
    const { userId, betAmount, game, choice } = req.body;
    if (betAmount <= 0) return res.status(400).json({ error: 'Apuesta no válida' });

    db.query('SELECT balance FROM users WHERE id = ?', [userId], (err, results) => {
        if (err || results.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

        const balance = parseFloat(results[0].balance);
        if (balance < betAmount) return res.status(400).json({ error: 'Fondos insuficientes en tu cuenta' });

        let win = false;
        let payout = 0;
        let outcomeMsg = '';

        // Lógica del servidor según el juego
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

        // Transacción segura en la base de datos
        db.beginTransaction(err => {
            if (err) return res.status(500).json({ error: 'Error de servidor' });

            db.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId], err => {
                if (err) return db.rollback(() => res.status(500).json({ error: 'Error actualizando saldo' }));

                db.query('INSERT INTO bets (user_id, amount, payout, result) VALUES (?, ?, ?, ?)', 
                    [userId, betAmount, payout, win ? 'win' : 'lose'], err => {
                    if (err) return db.rollback(() => res.status(500).json({ error: 'Error registrando apuesta' }));

                    db.commit(err => {
                        if (err) return db.rollback(() => res.status(500).json({ error: 'Error al confirmar transacción' }));
                        res.json({ win, payout, newBalance, outcome: outcomeMsg });
                    });
                });
            });
        });
    });
});

// Solicitar Retiro Real de Dinero
app.post('/api/withdraw', (req, res) => {
    const { userId, amount, method, account } = req.body;
    if (amount <= 0) return res.status(400).json({ error: 'Monto inválido' });

    db.query('SELECT balance FROM users WHERE id = ?', [userId], (err, results) => {
        if (err || results.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

        const balance = parseFloat(results[0].balance);
        if (balance < amount) return res.status(400).json({ error: 'Saldo insuficiente para retirar' });

        const newBalance = balance - amount;

        db.beginTransaction(err => {
            if (err) return res.status(500).json({ error: 'Error de servidor' });

            db.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId], err => {
                if (err) return db.rollback(() => res.status(500).json({ error: 'Error descontando saldo' }));

                db.query('INSERT INTO transactions (user_id, type, amount, method, destination, status) VALUES (?, "withdrawal", ?, ?, ?, "pending")', 
                    [userId, amount, method, account], err => {
                    if (err) return db.rollback(() => res.status(500).json({ error: 'Error guardando retiro' }));

                    db.commit(err => {
                        if (err) return db.rollback(() => res.status(500).json({ error: 'Error al confirmar' }));
                        res.json({ message: 'Solicitud de retiro creada con éxito', newBalance });
                    });
                });
            });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor real activo en puerto ${PORT}`));
