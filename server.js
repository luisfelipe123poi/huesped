require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();

// Middlewares
app.use(express.json());
app.use(cors());

// 1. Inicializar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 2. Conexión a MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/apartment-os';
mongoose.connect(MONGO_URI)
  .then(() => console.log('🟢 Conectado a MongoDB'))
  .catch(err => console.error('🔴 Error conectando a MongoDB:', err));

// ==========================================
// 3. MODELOS DE DATOS (Mongoose)
// ==========================================

// Esquema del "Digital Twin" del apartamento
const ApartmentSchema = new mongoose.Schema({
  apartment_id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  owner_id: { type: String, required: true },
  wifi: {
    ssid: String,
    pass: String
  },
  appliances: [{
    name: String,
    location: String,
    instructions: String
  }],
  rules: [String],
  faqs: [{
    question: String,
    answer: String
  }],
  createdAt: { type: Date, default: Date.now }
});

const Apartment = mongoose.model('Apartment', ApartmentSchema);

// Esquema de Tickets (Solicitudes, Problemas, Preguntas)
const TicketSchema = new mongoose.Schema({
  apartment_id: { type: String, required: true },
  type: { type: String, enum: ['question', 'request', 'issue'], required: true },
  category: { type: String }, // Ej: "Aire acondicionado", "Toallas", "Wi-Fi"
  description: { type: String, required: true },
  status: { type: String, enum: ['pending', 'in_progress', 'resolved'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const Ticket = mongoose.model('Ticket', TicketSchema);


// ==========================================
// 4. RUTAS DE LA API (Endpoints)
// ==========================================

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({ status: 'API Apartment Experience OS funcionando 🚀' });
});

// [GET] Obtener el Digital Twin del apartamento (para la vista del huésped por QR)
app.get('/api/apartment/:id', async (req, res) => {
  try {
    const apartment = await Apartment.findOne({ apartment_id: req.params.id });
    if (!apartment) {
      return res.status(404).json({ error: 'Apartamento no encontrado' });
    }
    res.json(apartment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// [POST] Crear o actualizar un apartamento (Para administración/seed inicial)
app.post('/api/apartment', async (req, res) => {
  try {
    const { apartment_id, name, owner_id, wifi, appliances, rules, faqs } = req.body;
    const apartment = await Apartment.findOneAndUpdate(
      { apartment_id },
      { name, owner_id, wifi, appliances, rules, faqs },
      { new: true, upsert: true }
    );
    res.json({ message: 'Apartamento guardado exitosamente', apartment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// [POST] Chat con IA contextual (El "Cerebro" del Apartamento)
app.post('/api/chat', async (req, res) => {
  try {
    const { apartment_id, message } = req.body;

    if (!apartment_id || !message) {
      return res.status(400).json({ error: 'Faltan apartment_id o message' });
    }

    // Buscar el contexto del apartamento
    const apartment = await Apartment.findOne({ apartment_id });
    if (!apartment) {
      return res.status(404).json({ error: 'Apartamento no encontrado' });
    }

    // Construir el prompt del sistema con el Digital Twin
    const systemPrompt = `
      Eres el asistente virtual operativo de este apartamento turístico llamado "${apartment.name}".
      Tu objetivo es ayudar al huésped con información exacta basada únicamente en los datos del apartamento.
      
      DATOS DEL APARTAMENTO:
      - Wi-Fi: SSID: ${apartment.wifi?.ssid || 'N/A'}, Password: ${apartment.wifi?.pass || 'N/A'}
      - Electrodomésticos y Guías: ${JSON.stringify(apartment.appliances)}
      - Reglas de la casa: ${JSON.stringify(apartment.rules)}
      - FAQs: ${JSON.stringify(apartment.faqs)}

      REGLAS:
      - Responde de forma amable, corta y directa en el idioma en que te escriba el huésped (principalmente español o inglés).
      - Si el huésped reporta un daño grave o algo no funciona y no lo puedes resolver con las instrucciones, indícale amablemente que has registrado la incidencia para avisar al anfitrión.
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Modelo rápido y económico ideal para esto
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.3,
    });

    const aiResponse = completion.choices[0].message.content;
    res.json({ response: aiResponse });

  } catch (error) {
    console.error('Error en /api/chat:', error);
    res.status(500).json({ error: 'Error procesando la solicitud con IA' });
  }
});

// [POST] Crear un ticket (Solicitud o Problema reportado por el huésped)
app.post('/api/tickets', async (req, res) => {
  try {
    const { apartment_id, type, category, description } = req.body;
    
    if (!apartment_id || !type || !description) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const newTicket = new Ticket({
      apartment_id,
      type,
      category: category || 'General',
      description,
      status: 'pending'
    });

    await newTicket.save();
    res.status(201).json({ message: 'Ticket creado correctamente', ticket: newTicket });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// [GET] Dashboard Property Pulse (Ver estado de los apartamentos y sus tickets para el propietario)
app.get('/api/owner/dashboard/:owner_id', async (req, res) => {
  try {
    const { owner_id } = req.params;
    const apartments = await Apartment.find({ owner_id });
    const aptIds = apartments.map(a => a.apartment_id);

    // Buscar tickets pendientes de estos apartamentos
    const tickets = await Ticket.find({ 
      apartment_id: { $in: aptIds },
      status: 'pending'
    }).sort({ createdAt: -1 });

    // Agrupar estado por apartamento
    const dashboardData = apartments.map(apt => {
      const aptTickets = tickets.filter(t => t.apartment_id === apt.apartment_id);
      const hasIssues = aptTickets.some(t => t.type === 'issue');
      const hasRequests = aptTickets.some(t => t.type === 'request');

      let statusColor = '🟢';
      if (hasIssues) statusColor = '🔴';
      else if (hasRequests) statusColor = '🟡';

      return {
        apartment_id: apt.apartment_id,
        name: apt.name,
        status: statusColor,
        pending_tickets: aptTickets
      };
    });

    res.json({ dashboard: dashboardData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 5. INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corroyendo en puerto ${PORT}`);
});
