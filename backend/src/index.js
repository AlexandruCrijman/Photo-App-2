import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
	res.json({ status: 'ok', uptime: process.uptime() });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
	console.log(`API listening on http://localhost:${port}`);
});


