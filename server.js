require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const OpenAI = require('openai');
const QRCode = require('qrcode');
const path = require('path');
const ical = require('node-ical');

const app = express();

// Middlewares
app.use(express.json());
app.use(cors());

// 1. Inicializar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==========================================
// 2. CONEXIÓN A MONGODB
// ==========================================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/apartment-os';
mongoose.connect(MONGO_URI)
  .then(() => console.log('🟢 Conectado a MongoDB'))
  .catch(err => console.error('🔴 Error conectando a MongoDB:', err));

// ==========================================
// 3. MODELOS DE DATOS Y CONFIGURACIÓN DE LIBRERÍAS
// ==========================================

// Esquema de Apartamento Actualizado (con iCal, tickets y selecciones embebidas)
const ApartmentSchema = new mongoose.Schema({
  apartment_id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  owner_id: { type: String, required: true },
  ownerId: { type: String }, // Mantiene compatibilidad con el dashboard del anfitrión
  wifi_config: { type: String, default: 'No configurado' },
  instructions: { type: String, default: '' },
  rules: { type: String, default: '' },
  ical_url: { type: String, default: '' }, // <-- Campo para sincronización iCal de Airbnb
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
  pending_tickets: { type: Array, default: [] }, // <-- Almacena las consultas/quejas del huésped
  guest_selections: { type: Array, default: [] }, // <-- Almacena consumos o compras de minibar/tours
  guest_url: { type: String },
  qr_code: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const Apartment = mongoose.model('Apartment', ApartmentSchema);

// Esquema de Ticket independiente (por si se usa de forma externa)
const TicketSchema = new mongoose.Schema({
  apartment_id: { type: String, required: true },
  type: { type: String, enum: ['question', 'request', 'issue'], required: true },
  category: { type: String },
  description: { type: String, required: true },
  status: { type: String, enum: ['pending', 'in_progress', 'resolved', 'Pendiente', 'En Proceso', 'Resuelto'], default: 'pending' },
  host_response: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const Ticket = mongoose.model('Ticket', TicketSchema);



// ==========================================
// FUNCIÓN PARA LEER EL iCAL DE AIRBNB
// ==========================================
async function getActiveReservationFromIcal(icalUrl) {
  if (!icalUrl) return null;

  try {
    // Descarga los eventos del enlace iCal de Airbnb en tiempo real
    const events = await ical.async.fromURL(icalUrl);
    const now = new Date();

    for (let k in events) {
      if (events[k].type === 'VEVENT') {
        const event = events[k];
        const startDate = new Date(event.start);
        const endDate = new Date(event.end);

        // Validamos si la fecha actual está dentro del rango de la reserva
        if (now >= startDate && now <= endDate) {
          return {
            checkIn: startDate.toISOString().split('T')[0],
            checkOut: endDate.toISOString().split('T')[0],
            summary: event.summary // Suele decir "Reservado" o el nombre del huésped
          };
        }
      }
    }
    return null; // No hay reservas activas en este preciso momento
  } catch (error) {
    console.error("Error al procesar el iCal:", error);
    return null;
  }
}

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

// [POST] Crear o actualizar un apartamento (Forzando Cloudflare para el guest_url e incluyendo iCal)
app.post('/api/owner/properties', async (req, res) => {
  try {
    const { ownerId, name, apartment_id, wifi_config, instructions, rules, ical_url } = req.body;

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
        ownerId: ownerId,
        wifi_config, 
        instructions, 
        rules, 
        ical_url: ical_url || '',
        guest_url, 
        qr_code 
      },
      { new: true, upsert: true }
    );

    res.json({ message: 'Propiedad guardada, iCal conectado y QR generado exitosamente', apartment });
  } catch (error) {
    console.error('Error al registrar propiedad:', error);
    res.status(500).json({ error: error.message });
  }
});

// Memoria temporal simple para almacenar los últimos lugares recomendados por apartamento
// (En producción puedes guardarlo en la base de datos dentro del modelo de Apartment o Session)
const recentRecommendations = {};

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

    // Inicializar memoria para este apartamento si no existe
    if (!recentRecommendations[apartment_id]) {
      recentRecommendations[apartment_id] = [];
    }

    const avoidedPlaces = recentRecommendations[apartment_id];

    // Obtener la información de la reserva en tiempo real desde el iCal de Airbnb
    const reservation = await getActiveReservationFromIcal(apartment.ical_url);

    let calendarContext = reservation 
      ? `Información real del calendario de reservas: El huésped actual entra el ${reservation.checkIn} y sale el ${reservation.checkOut}.`
      : `No se encontró una reserva activa específica en el calendario para este momento exacto.`;

    const systemPrompt = `
      You are the expert virtual assistant and VIP concierge of this luxury apartment ("${apartment.name}") in Cartagena de Colombia.
      
      CRITICAL SAFETY & ZERO-TOLERANCE POLICY:
      1. AUTOMATIC SAFETY & TRANSIT ADVISORY: Automatically analyze the location and surroundings of this apartment (${apartment.instructions || 'Cartagena'}). Whenever you give recommendations, directions, or discuss moving around from this property, you MUST proactively include a polite, non-alarming safety tip or transit advice (e.g., using secure apps like Uber/InDrive or radio-taxis for night trips).
      2. STRICT RED-ZONE & DANGER BLOCK: If the guest explicitly asks for directions, routes, or recommendations to visit dangerous areas, high-risk marginal neighborhoods, or engage in risky activities (e.g., "zonas rojas", shady slums, buying illegal substances, walking through unsafe peripheral zones for "adventure"), you MUST refuse strictly and politely. NEVER provide routes, maps, or addresses to these places. Firmly state that as a VIP concierge you prioritize their safety and wellbeing, and redirect them to secure, vibrant, and tourist-approved areas of Cartagena.
      3. NEVER recommend businesses or spots located inside dangerous zones or red areas. Always filter recommendations to safe, established, and tourist-friendly commercial areas or safe commercial strips nearby, even if the apartment itself is in a residential sector.

      OFFICIAL APARTMENT DATA:
      - Property Name: ${apartment.name || 'N/A'}
      - Wi-Fi Config: ${apartment.wifi_config || 'N/A'}
      - Apartment Instructions: ${apartment.instructions || 'N/A'}
      - House Rules: ${apartment.rules || 'N/A'}
      - Host WhatsApp: ${apartment.host_phone || '+573000000000'}
      - CALENDAR STATUS: ${calendarContext}

      STRICT RULES & STYLE:
      1. Detect the user's language and ALWAYS reply in that exact same language.
      2. ABSOLUTELY NO asterisks (*), NO markdown bullets (-, *), and NO numbered lists in plain text when giving recommendations or directions. Keep text responses short, elegant, and conversational.
      3. If the guest asks about their check-in, check-out dates, or duration of stay, use the CALENDAR STATUS provided above to answer accurately.

      RULE 1: APARTMENT INFO (APARTMENT_CARD)
      If the guest asks about apartment details, Wi-Fi, instructions, or rules, reply with short text and this exact JSON block:
      [APARTMENT_CARD]
      {
        "nombre": "${apartment.name || 'Luxury Apartment'}",
        "wifi": "${apartment.wifi_config || 'N/A'}",
        "instrucciones": "${apartment.instructions || 'N/A'}",
        "reglas": "${apartment.rules || 'N/A'}"
      }
      [/APARTMENT_CARD]

      RULE 2: LOCAL RECOMMENDATIONS (CARD_DATA - MANDATORY EXACTLY 3 DIFFERENT OPTIONS)
      If the guest asks for physical recommendations (restaurants, bars, pharmacies, supermarkets, beaches) or says "cerca" / "where to eat near" / "¿Dónde comer cerca?":
      - LOCAL PROXIMITY MANDATE: You MUST prioritize restaurants, cafes, or spots located in the immediate vicinity or nearby safe commercial sectors relative to this apartment's address/sector. Do NOT recommend places far away across the city.
      - CRITICAL EXCLUSION RULE: DO NOT recommend any of the following places because they were already shown recently: ${JSON.stringify(avoidedPlaces)}. You MUST choose 3 completely different, fresh, and varied places located in safe, well-lit, and recommended areas close to the property.
      - FORMAT REQUIREMENT: In your text response, provide a brief intro that *proactively includes any necessary safety/transit tip* for moving around from the apartment's sector. Then include the [CARD_DATA] block with EXACTLY 3 JSON objects. Do NOT list the recommendations in the plain text response; let the UI cards display them.
      
      [CARD_DATA]
      [
        {
          "nombre": "Business Name 1",
          "categoria": "Restaurante",
          "direccion": "Exact address near apartment location",
          "telefono": "Phone number",
          "enlace": "https://www.google.com/maps/search/?api=1&query=Business+Name+1+Cartagena",
          "descripcion_corta": "Short highlight why it's great"
        },
        {
          "nombre": "Business Name 2",
          "categoria": "Restaurante",
          "direccion": "Exact address near apartment location",
          "telefono": "Phone number",
          "enlace": "https://www.google.com/maps/search/?api=1&query=Business+Name+2+Cartagena",
          "descripcion_corta": "Short highlight why it's great"
        },
        {
          "nombre": "Business Name 3",
          "categoria": "Restaurante",
          "direccion": "Exact address near apartment location",
          "telefono": "Phone number",
          "enlace": "https://www.google.com/maps/search/?api=1&query=Business+Name+3+Cartagena",
          "descripcion_corta": "Short highlight why it's great"
        }
      ]
      [/CARD_DATA]

      RULE 3: SPECIFIC PLACE / ATTRACTION INFO (PLACE_DATA)
      If the guest asks how to get to a specific tourist site, plaza, monument, or location in Cartagena (e.g., Plaza de la Trinidad, Castillo de San Felipe, Getsemaní, Torre del Reloj):
      - Provide a brief, polite conversational text including a transit or safety tip for traveling from the apartment's location. 
      - CRITICAL: Do NOT print, display, or repeat the JSON structure or raw code inside your text response. Keep your text strictly conversational and natural.
      - You MUST include a [PLACE_DATA] block strictly at the end with a single JSON object containing the exact details so a map card can be rendered:
      
      [PLACE_DATA]
      {
        "nombre": "Nombre del sitio (ej. Plaza de la Trinidad)",
        "categoria": "Plaza Turística / Sitio de Interés",
        "direccion": "Dirección exacta del lugar en Cartagena",
        "enlace": "https://www.google.com/maps/search/?api=1&query=Nombre+del+sitio+Cartagena"
      }
      [/PLACE_DATA]

      RULE 4: VIP TOURS & EXPERIENCES (TOUR_DATA)
      If the guest asks for tours, boat trips, private chef, massage, etc., give a brief intro and include:
      [TOUR_DATA]
      [
        {
          "nombre": "Excursión Privada a Islas del Rosario",
          "categoria": "Tour VIP",
          "duracion": "Full Day (8 horas)",
          "incluye": "Lancha deportiva, capitán, guía y fruta fresca",
          "precio": "Desde $250.000 COP por persona",
          "whatsapp_query": "Hola, deseo reservar el Tour a Islas del Rosario desde el apartamento ${apartment.name}"
        }
      ]
      [/TOUR_DATA]
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.7,
    });

    let aiResponse = completion.choices[0].message.content;
    let cardsData = null;
    let apartmentCardData = null;
    let tourCardData = null;
    let placeCardData = null;

    const cardRegex = /\[CARD_DATA\]([\s\S]*?)\[\/CARD_DATA\]/;
    const matchCards = aiResponse.match(cardRegex);
    if (matchCards) {
      try { 
        cardsData = JSON.parse(matchCards[1].trim()); 
        aiResponse = aiResponse.replace(cardRegex, '').trim(); 
        
        cardsData.forEach(c => {
          if (c.nombre && !avoidedPlaces.includes(c.nombre)) {
            avoidedPlaces.push(c.nombre);
          }
        });
        if (avoidedPlaces.length > 15) {
          avoidedPlaces.splice(0, avoidedPlaces.length - 15);
        }
      } catch (e) {}
    }

    const cleanAptRegex = /\[APARTMENT_CARD\]([\s\S]*?)\[\/APARTMENT_CARD\]/;
    const matchApt = aiResponse.match(cleanAptRegex);
    if (matchApt) {
      try { apartmentCardData = JSON.parse(matchApt[1].trim()); aiResponse = aiResponse.replace(cleanAptRegex, '').trim(); } catch (e) {}
    }

    // Extracción robusta y limpieza total de PLACE_DATA
    const placeRegex = /\[PLACE_DATA\]([\s\S]*?)\[\/PLACE_DATA\]/i;
    const matchPlace = aiResponse.match(placeRegex);
    if (matchPlace) {
      try { 
        placeCardData = JSON.parse(matchPlace[1].trim()); 
      } catch (e) {}
      aiResponse = aiResponse.replace(placeRegex, '').trim();
    }

    const tourRegex = /\[TOUR_DATA\]([\s\S]*?)\[\/TOUR_DATA\]/;
    const matchTour = aiResponse.match(tourRegex);
    if (matchTour) {
      try { tourCardData = JSON.parse(matchTour[1].trim()); aiResponse = aiResponse.replace(tourRegex, '').trim(); } catch (e) {}
    }

    // Limpieza general extra por si quedan restos de etiquetas sueltas
    aiResponse = aiResponse.replace(/\[\/?PLACE_DATA\]/gi, '').trim();

    res.json({ 
      response: aiResponse, 
      cards: cardsData,
      apartmentCard: apartmentCardData,
      placeCard: placeCardData,
      tourCard: tourCardData,
      hostPhone: apartment.host_phone || '+573000000000',
      apartmentName: apartment.name || 'Apartamento'
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

// [GET] Listar tickets de un apartamento en tiempo real
app.get('/api/tickets', async (req, res) => {
  try {
    const { apartment_id } = req.query;
    
    if (!apartment_id) {
      return res.status(400).json({ error: 'Falta el parámetro apartment_id' });
    }

    // Buscamos los tickets ordenados por fecha de creación descendiente (los más recientes primero)
    const tickets = await Ticket.find({ apartment_id }).sort({ createdAt: -1 });
    
    res.status(200).json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// [POST] Actualizar el estado y respuesta de una solicitud/ticket del huésped
app.post('/api/owner/tickets/update', async (req, res) => {
  try {
    const { ownerId, apartment_id, ticket_index, status, host_response } = req.body;

    // 1. Buscar la propiedad del anfitrión
    const property = await Property.findOne({ ownerId, apartment_id });
    if (!property) {
      return res.status(404).json({ error: 'Propiedad no encontrada' });
    }

    // 2. Validar que el array de tickets exista y el índice sea válido
    if (!property.pending_tickets || !property.pending_tickets[ticket_index]) {
      return res.status(404).json({ error: 'Ticket no encontrado en la posición indicada' });
    }

    // 3. Actualizar el estado y la respuesta del anfitrión en ese ticket específico
    property.pending_tickets[ticket_index].status = status;
    property.pending_tickets[ticket_index].host_response = host_response;

    // 4. Guardar los cambios en la base de datos
    await property.save();

    res.status(200).json({ success: true, message: '¡Ticket actualizado correctamente!' });
  } catch (error) {
    console.error('Error al actualizar ticket:', error);
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
