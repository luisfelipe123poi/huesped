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

      DATOS OFICIALES DEL APARTAMENTO (REGISTRADOS POR EL ANFITRION):
      - Nombre de la Propiedad: ${apartment.name || 'N/A'}
      - Configuración de Wi-Fi: ${apartment.wifi_config || 'N/A'}
      - Instrucciones del Apto: ${apartment.instructions || 'N/A'}
      - Reglas de la Casa: ${apartment.rules || 'N/A'}

      REGLAS DE FORMATO Y ESTILO (ESTRICTO):
      1. Prohibido usar asteriscos, guiones de listado o símbolos extraños en tus respuestas de texto. Redacta de forma completamente limpia, fluida y natural.

      REGLA OBLIGATORIA PARA INFORMACIÓN DEL APARTAMENTO:
      Si el huésped pregunta por la información general del apartamento, detalles del lugar, Wi-Fi, instrucciones de llegada o reglas, DEBES darle una breve bienvenida en texto y, al final, incluir un bloque JSON exacto envuelto en las etiquetas [APARTMENT_CARD] y [/APARTMENT_CARD] con esta estructura:

      [APARTMENT_CARD]
      {
        "nombre": "${apartment.name || 'Apartamento Exclusivo'}",
        "wifi": "${apartment.wifi_config || 'No especificado'}",
        "instrucciones": "${apartment.instructions || 'No especificadas'}",
        "reglas": "${apartment.rules || 'No especificadas'}"
      }
      [/APARTMENT_CARD]

      REGLA OBLIGATORIA PARA RECOMENDACIONES (3 OPCIONES):
      Siempre que el huésped pida una recomendación de lugares físicos (restaurantes, bares, farmacias, supermercados, playas), DEBES darle una breve introducción en texto y, al final, incluir un arreglo JSON con exactamente 3 opciones en las etiquetas [CARD_DATA] y [/CARD_DATA]:

      [CARD_DATA]
      [
        {
          "nombre": "Nombre del Negocio",
          "categoria": "Restaurante",
          "direccion": "Dirección exacta en zona segura",
          "telefono": "Teléfono de contacto",
          "enlace": "https://www.google.com/maps/search/?api=1&query=Nombre+del+Negocio+Cartagena",
          "descripcion_corta": "Breve por qué se destaca"
        },
        {
          "nombre": "Nombre del Segundo Negocio",
          "categoria": "Restaurante",
          "direccion": "Dirección exacta en zona segura",
          "telefono": "Teléfono de contacto",
          "enlace": "https://www.google.com/maps/search/?api=1&query=Segundo+Negocio+Cartagena",
          "descripcion_corta": "Breve por qué se destaca"
        },
        {
          "nombre": "Nombre del Tercer Negocio",
          "categoria": "Restaurante",
          "direccion": "Dirección exacta en zona segura",
          "telefono": "Teléfono de contacto",
          "enlace": "https://www.google.com/maps/search/?api=1&query=Tercer+Negocio+Cartagena",
          "descripcion_corta": "Breve por qué se destaca"
        }
      ]
      [/CARD_DATA]

      Si el usuario solo saluda cordialmente, respóndele de forma normal en texto limpio sin tarjetas.
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.3,
    });

    let aiResponse = completion.choices[0].message.content;
    let cardsData = null;
    let apartmentCardData = null;

    // 1. Extraer bloque de recomendaciones [CARD_DATA]
    const cardRegex = /\[CARD_DATA\]([\s\S]*?)\[\/CARD_DATA\]/;
    const matchCards = aiResponse.match(cardRegex);
    if (matchCards) {
      try {
        cardsData = JSON.parse(matchCards[1].trim());
        aiResponse = aiResponse.replace(cardRegex, '').trim();
      } catch (e) {
        console.error('Error parseando cardsData:', e);
      }
    }

    // 2. Extraer bloque de info del apto [APARTMENT_CARD]
    const aptRegex = /\[APARTMENT_CARD\]([\s\S]*?)\[\/APARTMENT_CARD\]/;
    const matchApt = aiResponse.match(aptRegex);
    if (matchApt) {
      try {
        apartmentCardData = JSON.parse(matchApt[1].trim());
        aiResponse = aiResponse.replace(aptRegex, '').trim();
      } catch (e) {
        console.error('Error parseando apartmentCardData:', e);
      }
    }

    res.json({ 
      response: aiResponse, 
      cards: cardsData,
      apartmentCard: apartmentCardData
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
