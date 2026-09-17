require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const OpenAI = require('openai');
const QRCode = require('qrcode');
const path = require('path');

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

const ApartmentSchema = new mongoose.Schema({
  apartment_id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  owner_id: { type: String, required: true },
  wifi_config: { type: String, default: 'No configurado' },
  instructions: { type: String, default: '' },
  rules: { type: String, default: '' },
  wifi: {
    ssid: String,
    pass: String
  },
  appliances: [{
    name: String,
    location: String,
    instructions: String
  }],
  faqs: [{
    question: String,
    answer: String
  }],
  guest_url: { type: String },
  qr_code: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const Apartment = mongoose.model('Apartment', ApartmentSchema);

const TicketSchema = new mongoose.Schema({
  apartment_id: { type: String, required: true },
  type: { type: String, enum: ['question', 'request', 'issue'], required: true },
  category: { type: String },
  description: { type: String, required: true },
  status: { type: String, enum: ['pending', 'in_progress', 'resolved'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const Ticket = mongoose.model('Ticket', TicketSchema);


// ==========================================
// 4. RUTAS DE LA API (Endpoints)
// ==========================================

// [GET] Obtener el Digital Twin del apartamento
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

// [POST] Crear o actualizar un apartamento (Forzando Cloudflare para el guest_url)
app.post('/api/owner/properties', async (req, res) => {
  try {
    const { ownerId, name, apartment_id, wifi_config, instructions, rules } = req.body;

    if (!apartment_id || !name || !ownerId) {
      return res.status(400).json({ error: 'Faltan campos obligatorios (apartment_id, name, ownerId)' });
    }

    // URL base fija directo al frontend de Cloudflare (huesped1)
    const frontendBaseUrl = 'https://huesped1.prestigecloser.com';
    const guest_url = `${frontendBaseUrl}/guest.html?id=${apartment_id}`;

    // Generar código QR en formato Data URL (Base64)
    const qr_code = await QRCode.toDataURL(guest_url);

    const apartment = await Apartment.findOneAndUpdate(
      { apartment_id },
      { 
        name, 
        owner_id: ownerId, 
        wifi_config, 
        instructions, 
        rules, 
        guest_url, 
        qr_code 
      },
      { new: true, upsert: true }
    );

    res.json({ message: 'Propiedad guardada y QR generado exitosamente', apartment });
  } catch (error) {
    console.error('Error al registrar propiedad:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { apartment_id, message } = req.body;

    if (!apartment_id || !message) {
      return res.status(400).json({ error: 'Faltan apartment_id o message' });
    }

    const apartment = await Apartment.findOne({ apartment_id });
    if (!apartment) {
      return res.status(404).json({ error: 'Apartamento no encontrado' });
    }

    const systemPrompt = `
      Eres el asistente virtual y guía turístico experto de este apartamento ("${apartment.name}") en Cartagena de Indias.
      Zonas permitidas: Centro Histórico, Bocagrande, El Laguito, Marbella, Getsemaní y Manga. Evita barrios peligrosos.

      DATOS DEL APARTAMENTO (Usa esta información SOLO si el huésped pregunta por el Wi-Fi, instrucciones o reglas del lugar):
      - Wi-Fi: ${apartment.wifi_config || 'N/A'}
      - Instrucciones: ${apartment.instructions || 'N/A'}
      - Reglas: ${apartment.rules || 'N/A'}

      REGLAS DE FORMATO Y ESTILO (ESTRICTO):
      1. Prohibido usar asteriscos, guiones de listado o cualquier símbolo de formato extraño al escribir tus respuestas. Redacta de forma completamente limpia, fluida y natural, como una conversación humana real y elegante.
      2. Si el huésped pregunta por la información del apartamento, respóndele de manera redactada en párrafos limpios, sin listas con viñetas ni marcas de texto.

      REGLA OBLIGATORIA PARA RECOMENDACIONES:
      Cada vez que el huésped pida una recomendación de un restaurante, tienda, farmacia, supermercado, playa o sitio físico, DEBES incluir al final de tu respuesta un bloque JSON estructurado exactamente con este formato, envuelto en etiquetas [CARD_DATA] y [/CARD_DATA]:

      [CARD_DATA]
      {
        "nombre": "Nombre Real del Negocio",
        "categoria": "Restaurante / Farmacia / Supermercado",
        "direccion": "Dirección exacta en zona segura",
        "telefono": "Teléfono de contacto público",
        "enlace": "https://www.google.com/maps/search/?api=1&query=Nombre+del+Negocio+Cartagena",
        "descripcion_corta": "Breve por qué se recomienda en una sola línea atractiva"
      }
      [/CARD_DATA]

      Si el usuario solo saluda o hace una pregunta operativa del apartamento, responde de forma normal en texto limpio sin el bloque de card.
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.4,
    });

    let aiResponse = completion.choices[0].message.content;
    let cardData = null;

    // Extraer y limpiar el bloque [CARD_DATA] de la respuesta de la IA
    const cardRegex = /\[CARD_DATA\]([\s\S]*?)\[\/CARD_DATA\]/;
    const match = aiResponse.match(cardRegex);

    if (match) {
      try {
        // Parsear el JSON interno de la card
        cardData = JSON.parse(match[1].trim());
        // Remover el bloque de etiquetas [CARD_DATA] del texto para que el mensaje del chat quede completamente limpio
        aiResponse = aiResponse.replace(cardRegex, '').trim();
      } catch (parseError) {
        console.error('Error al parsear el JSON de la card de la IA:', parseError);
      }
    }

    // Devolver el texto limpio y el objeto de la tarjeta separado al frontend
    res.json({ 
      response: aiResponse, 
      card: cardData 
    });

  } catch (error) {
    console.error('Error en /api/chat:', error);
    res.status(500).json({ error: 'Error procesando la solicitud con IA' });
  }
});

// [POST] Crear un ticket
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

// [GET] Dashboard Property Pulse
app.get('/api/owner/dashboard/:owner_id', async (req, res) => {
  try {
    const { owner_id } = req.params;
    const apartments = await Apartment.find({ owner_id });
    const aptIds = apartments.map(a => a.apartment_id);

    const tickets = await Ticket.find({ 
      apartment_id: { $in: aptIds },
      status: 'pending'
    }).sort({ createdAt: -1 });

    const dashboardData = apartments.map(apt => {
      const aptTickets = tickets.filter(t => t.apartment_id === apt.apartment_id);
      const hasIssues = aptTickets.some(t => t.type === 'issue');
      const hasRequests = aptTickets.some(t => t.type === 'request');

      let statusColor = 'Activo';
      if (hasIssues) statusColor = 'Urgente';
      else if (hasRequests) statusColor = 'Pendiente';

      return {
        apartment_id: apt.apartment_id,
        name: apt.name,
        status: statusColor,
        guest_url: apt.guest_url,
        qr_code: apt.qr_code,
        pending_tickets: aptTickets
      };
    });

    res.json({ dashboard: dashboardData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 5. CONFIGURACIÓN DE ARCHIVOS ESTÁTICOS Y RUTAS HTML
// ==========================================

// Servir archivos estáticos desde la raíz
app.use(express.static(path.join(__dirname)));

// Ruta explícita para el Huésped
app.get('/guest.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'guest.html'));
});

// Ruta raíz
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'guest.html'));
});

// ==========================================
// 6. INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
