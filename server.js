import express from 'express';
import mongoose from 'mongoose';
import OpenAI from 'openai';
import cors from 'cors';
import 'dotenv/config';

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// 1. Conexión a MongoDB Atlas
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('Error: La variable MONGODB_URI no está definida.');
} else {
  mongoose
    .connect(MONGODB_URI)
    .then(() => console.log('✅ Conectado exitosamente a MongoDB Atlas'))
    .catch((err) => console.error('❌ Error de conexión a MongoDB:', err.message));
}

// 2. Definir el Esquema y Modelo de Mongoose
const ChatSchema = new mongoose.Schema({
  userMessage: { type: String, required: true },
  aiResponse: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Chat = mongoose.model('Chat', ChatSchema);

// 3. Inicializar Cliente de OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 4. Endpoints de la API

// Ruta de prueba
app.get('/', (req, res) => {
  res.send({ status: 'ok', message: 'Servidor en línea' });
});

// Ruta principal: Procesar mensaje con IA y guardar en MongoDB
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'El campo "message" es obligatorio.' });
    }

    // A. Llamada a OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: message }],
    });

    const aiResponseText = completion.choices[0].message.content;

    // B. Guardar registro en MongoDB
    const nuevoRegistro = new Chat({
      userMessage: message,
      aiResponse: aiResponseText
    });

    await nuevoRegistro.save();

    // C. Respuesta al Frontend
    return res.status(200).json({
      success: true,
      data: nuevoRegistro
    });

  } catch (error) {
    console.error('Error en /api/chat:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Error interno del servidor'
    });
  }
});

// Ruta para obtener el historial de chats guardados
app.get('/api/chat/history', async (req, res) => {
  try {
    const chats = await Chat.find().sort({ createdAt: -1 }).limit(20);
    return res.status(200).json({ success: true, data: chats });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Iniciar el Servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});
