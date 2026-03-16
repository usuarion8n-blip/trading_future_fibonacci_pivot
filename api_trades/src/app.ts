import express from 'express';
import cors from 'cors';
import tradesRouter from './routes/trades.js';

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', tradesRouter);

// Basic health check route
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'API is running' });
});

// Example route
app.get('/', (req, res) => {
    res.json({ message: 'Welcome to api_trades API' });
});

export default app;
