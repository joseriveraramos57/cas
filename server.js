// Registro con prueba de conexión previa
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Faltan datos' });
        }

        // Probemos si la conexión responde antes de insertar
        await db.query('SELECT 1');

        const hash = await bcrypt.hash(password, 10);
        
        const [result] = await db.query(
            'INSERT INTO users (username, password_hash, balance) VALUES (?, ?, 0.00)', 
            [username, hash]
        );
        
        res.json({ message: 'Usuario creado con éxito', userId: result.insertId });
    } catch (e) {
        console.error("ERROR REAL:", e);
        // Devolvemos el tipo de error o su representación en texto real
        const errorMsg = e.message || e.code || JSON.stringify(e);
        return res.status(400).json({ error: 'Fallo real: ' + errorMsg });
    }
});
