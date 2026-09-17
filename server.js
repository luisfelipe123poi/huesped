import express from 'express';
import mongoose from 'mongoose';
import OpenAI from 'openai';
import cors from 'cors';

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// 1. Obtención de Variables de Entorno de Render
const MONGODB_URI = process.env.MONGODB_URI;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Diagnóstico inicial en consola
console.log('📌 Estado MONGODB_URI:', MONGODB_URI ? 'Cargada' : '❌ NO DEFINIDA');
console.log('📌 Estado OPENAI_API_KEY:', OPENAI_API_KEY ? 'Cargada' : '❌ NO DEFINIDA');

// Conexión a MongoDB Atlas
if (MONGODB_URI) {
  mongoose
    .connect(MONGODB_URI)
    .then(() => console.log('✅ Conectado exitosamente a MongoDB Atlas'))
    .catch((err) => console.error('❌ Error al conectar con MongoDB:', err.message));
} else {
  console.error('⚠️ La app inició sin MONGODB_URI. Revisa la sección Environment en Render.');
}

// 2. Definir Esquema y Modelo
const ChatSchema = new mongoose.Schema({
  userMessage: { type: String, required: true },
  aiResponse: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Chat = mongoose.model('Chat', ChatSchema);

// 3. Inicializar Cliente de OpenAI
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY || 'KEY_NO_CONFIGURADA'
});

// 4. Rutas / Endpoints

// Ruta de estado
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Servidor en línea en Render' });
});

// Procesar mensaje
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'El campo "message" es obligatorio.' });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Falta la API Key de OpenAI en el servidor.' });
    }

    // A. Llamada a OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: message }],
    });

    const aiResponseText = completion.choices[0].message.content;

    // B. Guardar en MongoDB
    const nuevoRegistro = new Chat({
      userMessage: message,
      aiResponse: aiResponseText
    });

    await nuevoRegistro.save();

    // C. Respuesta
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

// Historial
app.get('/api/chat/history', async (req, res) => {
  try {
    const chats = await Chat.find().sort({ createdAt: -1 }).limit(20);
    return res.status(200).json({ success: true, data: chats });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Encendido del Servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor listo escuchando en el puerto ${PORT}`);
});
