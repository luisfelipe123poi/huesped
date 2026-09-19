require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const OpenAI = require('openai');
const QRCode = require('qrcode');
const path = require('path');
const ical = require('node-ical');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'mi_clave_secreta_concierge_luxury_2026';

const app = express();

// ==========================================
// 1. MIDDLEWARES (CORS Y PARSEO CONFIGURADOS CORRECTAMENTE)
// ==========================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Responder explícitamente a las peticiones Preflight OPTIONS
app.options('*', cors());

app.use(express.json());

// 1.1 Inicializar OpenAI
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

// 1. Esquema para Subdocumentos de Soporte / Quejas
const TicketSchema = new mongoose.Schema({
  apartment_id: { type: String, required: true },
  type: { 
    type: String, 
    enum: ['question', 'request', 'issue', 'General', 'Duda', 'Queja'], 
    default: 'question' 
  },
  category: { type: String, default: 'General' },
  description: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'in_progress', 'resolved', 'Pendiente', 'En Proceso', 'Resuelto'], 
    default: 'Pendiente' 
  },
  host_response: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Ticket = mongoose.model('Ticket', TicketSchema);

// 2. Esquema para Consumos y Servicios del Huésped
const GuestSelectionSchema = new mongoose.Schema({
  apartment_id: { type: String, required: true },
  item_name: { type: String, required: true },
  category: { type: String, default: 'Minibar' },
  price: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const GuestSelection = mongoose.model('GuestSelection', GuestSelectionSchema);

// 3. Esquemas de Utilidades Internas del Apartamento
const ApplianceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  location: { type: String, default: '' },
  instructions: { type: String, default: '' }
});

const FaqSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true }
});

// 4. Esquema Principal de Propiedades / Apartamentos
const ApartmentSchema = new mongoose.Schema({
  apartment_id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  owner_id: { type: String, required: true },
  ownerId: { type: String },
  status: { type: String, default: 'Activo' },
  wifi_config: { type: String, default: 'No configurado' },
  instructions: { type: String, default: '' },
  rules: { type: String, default: '' },
  ical_url: { type: String, default: '' },
  wifi: {
    ssid: { type: String, default: '' },
    pass: { type: String, default: '' }
  },
  appliances: [ApplianceSchema],
  faqs: [FaqSchema],
  // Integración de subdocumentos para permitir almacenamiento unificado o embebido
  pending_tickets: [TicketSchema],
  guest_selections: [GuestSelectionSchema],
  guest_url: { type: String, default: '' },
  qr_code: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const Apartment = mongoose.model('Apartment', ApartmentSchema);

module.exports = {
  Apartment,
  Ticket,
  GuestSelection
};

// ==========================================
// FUNCIÓN PARA LEER EL iCAL DE AIRBNB
// ==========================================
async function getActiveReservationFromIcal(icalUrl) {
  if (!icalUrl) return null;

  try {
    const events = await ical.async.fromURL(icalUrl);
    const now = new Date();

    for (let k in events) {
      if (events[k].type === 'VEVENT') {
        const event = events[k];
        const startDate = new Date(event.start);
        const endDate = new Date(event.end);

        if (now >= startDate && now <= endDate) {
          return {
            id: event.uid || k,
            checkIn: startDate,
            checkOut: endDate,
            guestName: event.summary || 'Huésped VIP'
          };
        }
      }
    }
    return null;
  } catch (error) {
    console.error("Error al procesar el iCal:", error);
    return null;
  }
}

// ==========================================
// 4. RUTAS DE LA API (Declaradas explícitamente)
// ==========================================

app.post('/api/guest/authenticate-qr', async (req, res) => {
  try {
    const { aptId } = req.body;

    if (!aptId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Se requiere el ID de la propiedad.' 
      });
    }

    const cleanAptId = decodeURIComponent(String(aptId)).trim();

    const queryConditions = [{ apartment_id: cleanAptId }];
    if (mongoose.Types.ObjectId.isValid(cleanAptId)) {
      queryConditions.push({ _id: cleanAptId });
    }

    const apartment = await Apartment.findOne({ $or: queryConditions });

    if (!apartment) {
      return res.status(404).json({ 
        success: false, 
        message: 'Propiedad no encontrada.' 
      });
    }

    const activeReservation = await getActiveReservationFromIcal(apartment.ical_url);

    if (!activeReservation) {
      return res.status(403).json({
        success: false,
        code: 'NO_ACTIVE_RESERVATION',
        message: 'No hay ninguna reserva activa registrada para esta propiedad.'
      });
    }

    const now = new Date();
    const checkOutDate = new Date(activeReservation.checkOut);
    const secondsUntilCheckOut = Math.floor((checkOutDate.getTime() - now.getTime()) / 1000);

    if (secondsUntilCheckOut <= 0) {
      return res.status(403).json({
        success: false,
        code: 'STAY_EXPIRED',
        message: 'Tu estancia ha finalizado.'
      });
    }

    const stayToken = jwt.sign(
      {
        aptId: apartment.apartment_id || apartment._id,
        reservationId: activeReservation.id,
        guestName: activeReservation.guestName,
        checkIn: activeReservation.checkIn,
        checkOut: activeReservation.checkOut
      },
      JWT_SECRET,
      { expiresIn: secondsUntilCheckOut }
    );

    return res.json({
      success: true,
      token: stayToken,
      guestName: activeReservation.guestName,
      checkOut: activeReservation.checkOut,
      redirectUrl: `/platform?token=${stayToken}&apt=${apartment.apartment_id || apartment._id}`
    });

  } catch (error) {
    console.error('Error en authenticate-qr:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Error interno del servidor al validar el acceso.' 
    });
  }
});

app.all('/api/guest/authenticate-qr', (req, res) => {
  res.status(405).json({ success: false, message: `El método ${req.method} no está permitido en este endpoint.` });
});

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

// [POST] Crear o actualizar un apartamento
app.post('/api/owner/properties', async (req, res) => {
  try {
    const { ownerId, name, apartment_id, wifi_config, instructions, rules, ical_url } = req.body;

    if (!apartment_id || !name || !ownerId) {
      return res.status(400).json({ error: 'Faltan campos obligatorios (apartment_id, name, ownerId)' });
    }

    const frontendBaseUrl = 'https://huesped1.prestigecloser.com';
    const guest_url = `${frontendBaseUrl}/guest.html?id=${apartment_id}`;
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

const recentRecommendations = {};

// [POST] Chat Concierge con IA
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

    if (!recentRecommendations[apartment_id]) {
      recentRecommendations[apartment_id] = [];
    }

    const avoidedPlaces = recentRecommendations[apartment_id];
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
      If the guest asks how to get to, asks directions to, or expresses a desire to visit a tourist site, plaza, monument, safe neighborhood, or location in Cartagena:
      - INTENT & SAFETY CHECK: 
        A) If the guest explicitly asks for dangerous areas, high-risk zones, red zones, "zonas calientes", "adrenalina", marginal neighborhoods, or risky adventures, OR if they ask specifically for directions to any of these restricted neighborhoods: [El Pozón, Olaya Herrera, La María, Nelson Mandela, Fredonia, 13 de Junio, La Candelaria, La Esperanza, Flor del Campo, Ciudadela 2000, Albornoz, Arroz Barato].
        B) You MUST strictly and politely refuse. Respond verbatim or with the exact sentiment of: "Como asistente VIP, debo priorizar tu seguridad y bienestar. No puedo recomendarte rutas hacia áreas de riesgo o peligrosas. Te sugiero que te quedes en zonas seguras y turísticas de Cartagena. Si necesitas ayuda para explorar lugares más seguros, estaré encantado de ayudarte." 
        C) Do NOT provide any routes, directions, or map cards, and DO NOT output any [PLACE_DATA] block for these cases.
      - IF THE PLACE IS SAFE AND ALLOWED (Prioritize recognized safe zones and tourist areas such as: Centro Histórico, San Diego, Getsemaní, Bocagrande, El Laguito, Castillogrande, Manga, El Cabrero, Marbella, Crespo, or Zona Norte): 
        Provide a brief, polite conversational text that MANDATORY includes a disclaimer and transit/safety tip (e.g., recommending secure apps like Uber or InDrive for the trip). You MUST include the [PLACE_DATA] block strictly at the end with a single JSON object containing a representative Unsplash image URL so a rich map card with image can be rendered:
      
      [PLACE_DATA]
      {
        "nombre": "Nombre del sitio consultado",
        "categoria": "Sitio de Interés / Zona Segura de Cartagena",
        "direccion": "Dirección o ubicación en Cartagena",
        "imagen": "https://images.unsplash.com/photo-1583531172055-e995b8a5d775",
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

    const placeRegex = /\[PLACE_DATA\]([\s\S]*?)\[\/PLACE_DATA\]/i;
    const matchPlace = aiResponse.match(placeRegex);
    if (matchPlace) {
      try { 
        placeCardData = JSON.parse(matchPlace[1].trim()); 
      } catch (e) {}
      aiResponse = aiResponse.replace(placeRegex, '').trim();
    } else {
      const looseJsonRegex = /\{[\s\S]*?"nombre"[\s\S]*?"direccion"[\s\S]*?\}/i;
      const matchLoose = aiResponse.match(looseJsonRegex);
      if (matchLoose) {
        try {
          placeCardData = JSON.parse(matchLoose[0].trim());
          aiResponse = aiResponse.replace(looseJsonRegex, '').trim();
        } catch (e) {}
      }
    }

    const tourRegex = /\[TOUR_DATA\]([\s\S]*?)\[\/TOUR_DATA\]/;
    const matchTour = aiResponse.match(tourRegex);
    if (matchTour) {
      try { tourCardData = JSON.parse(matchTour[1].trim()); aiResponse = aiResponse.replace(tourRegex, '').trim(); } catch (e) {}
    }

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

// [POST] Crear un ticket desde cliente público/huésped
app.post('/api/tickets', async (req, res) => {
  try {
    const { apartment_id, type, category, description } = req.body;
    
    if (!apartment_id || (!type && !category) || !description) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    // 1. Guardar en colección independiente
    const newTicket = new Ticket({
      apartment_id,
      type: type || 'question',
      category: category || 'General',
      description,
      status: 'pending'
    });
    await newTicket.save();

    // 2. Guardar también en el documento del apartamento (embebido)
    const property = await Apartment.findOne({ apartment_id });
    if (property) {
      property.pending_tickets.push({
        _id: newTicket._id,
        apartment_id,
        type: type || 'question',
        category: category || 'General',
        description,
        status: 'Pendiente',
        createdAt: newTicket.createdAt
      });
      await property.save();
    }

    res.status(201).json({ message: 'Ticket creado correctamente', ticket: newTicket });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// [GET] Listar tickets de un apartamento
app.get('/api/tickets', async (req, res) => {
  try {
    const { apartment_id } = req.query;
    
    if (!apartment_id) {
      return res.status(400).json({ error: 'Falta el parámetro apartment_id' });
    }

    const tickets = await Ticket.find({ apartment_id }).sort({ createdAt: -1 });
    res.status(200).json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ENDPOINTS ESPECIALIZADOS PARA LA VISTA ANFITRIÓN & POLLING
// ==========================================

// [GET] Polling de tickets para el Anfitrión
app.get('/api/owner/tickets', async (req, res) => {
  try {
    const { ownerId, apartment_id } = req.query;

    if (!ownerId && !apartment_id) {
      return res.status(400).json({ error: 'Se requiere ownerId o apartment_id para la consulta.' });
    }

    let queryFilter = {};
    if (apartment_id) {
      queryFilter.apartment_id = apartment_id;
    } else {
      const apartments = await Apartment.find({ $or: [{ owner_id: ownerId }, { ownerId }] });
      const aptIds = apartments.map(a => a.apartment_id);
      queryFilter.apartment_id = { $in: aptIds };
    }

    const tickets = await Ticket.find(queryFilter).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, tickets });
  } catch (error) {
    console.error('Error al consultar tickets en polling:', error);
    return res.status(500).json({ error: error.message });
  }
});

// [GET] Polling de consumos/selecciones para el Anfitrión
app.get('/api/owner/selections', async (req, res) => {
  try {
    const { ownerId, apartment_id } = req.query;

    if (!ownerId && !apartment_id) {
      return res.status(400).json({ error: 'Se requiere ownerId o apartment_id para la consulta.' });
    }

    let queryFilter = {};
    if (apartment_id) {
      queryFilter.apartment_id = apartment_id;
    } else {
      const apartments = await Apartment.find({ $or: [{ owner_id: ownerId }, { ownerId }] });
      const aptIds = apartments.map(a => a.apartment_id);
      queryFilter.apartment_id = { $in: aptIds };
    }

    const selections = await GuestSelection.find(queryFilter).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, selections });
  } catch (error) {
    console.error('Error al consultar consumos en polling:', error);
    return res.status(500).json({ error: error.message });
  }
});

// [POST] Actualizar el estado y respuesta de una solicitud/ticket del huésped
app.post('/api/owner/tickets/update', async (req, res) => {
  try {
    const { ownerId, apartment_id, ticket_index, ticket_id, status, host_response } = req.body;

    if (!apartment_id || (ticket_index === undefined && !ticket_id) || !host_response) {
      return res.status(400).json({ error: 'Faltan parámetros obligatorios para actualizar el ticket.' });
    }

    const property = await Apartment.findOne({
      apartment_id,
      $or: [{ owner_id: ownerId }, { ownerId }]
    });

    if (!property) {
      return res.status(404).json({ error: 'Propiedad no encontrada o no pertenece al anfitrión.' });
    }

    let ticketUpdated = false;

    // CASO A: Actualizar en modelo independiente `Ticket`
    const ticketQuery = ticket_id 
      ? { _id: ticket_id, apartment_id } 
      : { apartment_id };

    const ticketDoc = ticket_id 
      ? await Ticket.findOne(ticketQuery)
      : (await Ticket.find({ apartment_id }).sort({ createdAt: -1 }))[ticket_index];

    if (ticketDoc) {
      ticketDoc.status = status || 'Resuelto';
      ticketDoc.host_response = host_response;
      ticketDoc.updatedAt = new Date();
      await ticketDoc.save();
      ticketUpdated = true;
    }

    // CASO B: Actualizar en el arreglo embebido `pending_tickets`
    if (Array.isArray(property.pending_tickets) && property.pending_tickets.length > 0) {
      let targetTicket = null;
      if (ticket_id) {
        targetTicket = property.pending_tickets.find(t => t._id && t._id.toString() === ticket_id.toString());
      } else if (ticket_index !== undefined && property.pending_tickets[ticket_index]) {
        targetTicket = property.pending_tickets[ticket_index];
      }

      if (targetTicket) {
        targetTicket.status = status || 'Resuelto';
        targetTicket.host_response = host_response;
        targetTicket.updatedAt = new Date();
        property.markModified('pending_tickets');
        await property.save();
        ticketUpdated = true;
      }
    }

    if (!ticketUpdated) {
      return res.status(404).json({ error: 'Ticket no encontrado en la posición o ID especificado.' });
    }

    return res.status(200).json({ 
      success: true, 
      message: '¡Ticket actualizado y respuesta guardada correctamente!' 
    });

  } catch (error) {
    console.error('Error al actualizar ticket:', error);
    return res.status(500).json({ error: error.message || 'Error interno del servidor.' });
  }
});

// [POST] Crear un ticket desde la interfaz de huésped
app.post('/api/guest/tickets', async (req, res) => {
  try {
    const { apartment_id, category, description } = req.body;

    const property = await Apartment.findOne({ apartment_id });
    if (!property) return res.status(404).json({ error: 'Apartamento no encontrado.' });

    const newTicketDoc = new Ticket({
      apartment_id,
      category: category || 'General',
      description,
      status: 'pending'
    });
    await newTicketDoc.save();

    const newTicketEmbedded = {
      _id: newTicketDoc._id,
      category: category || 'General',
      description,
      status: 'Pendiente',
      host_response: '',
      createdAt: new Date()
    };

    property.pending_tickets.push(newTicketEmbedded);
    await property.save();

    return res.status(201).json({ message: 'Solicitud enviada al anfitrión', ticket: newTicketEmbedded });
  } catch (error) {
    console.error('Error al registrar ticket del huésped:', error);
    return res.status(500).json({ error: 'Error al registrar la solicitud.' });
  }
});

// [POST] Registrar selecciones/consumos desde la interfaz de huésped
app.post('/api/guest/selections', async (req, res) => {
  try {
    const { apartment_id, item_name, category, price } = req.body;

    const property = await Apartment.findOne({ apartment_id });
    if (!property) return res.status(404).json({ error: 'Apartamento no encontrado.' });

    const newSelectionDoc = new GuestSelection({
      apartment_id,
      item_name,
      category: category || 'Minibar',
      price: price || 0
    });
    await newSelectionDoc.save();

    const newSelectionEmbedded = {
      _id: newSelectionDoc._id,
      item_name,
      category: category || 'Minibar',
      price: price || 0,
      createdAt: new Date()
    };

    property.guest_selections.push(newSelectionEmbedded);
    await property.save();

    return res.status(201).json({ message: 'Consumo registrado', selection: newSelectionEmbedded });
  } catch (error) {
    console.error('Error al registrar consumo del huésped:', error);
    return res.status(500).json({ error: 'Error al registrar el consumo.' });
  }
});

// [GET] Dashboard Property Pulse
app.get('/api/owner/dashboard/:owner_id', async (req, res) => {
  try {
    const { owner_id } = req.params;

    // 1. Obtener todos los apartamentos del anfitrión
    const apartments = await Apartment.find({ 
      $or: [{ owner_id }, { ownerId: owner_id }] 
    });
    
    const aptIds = apartments.map(a => a.apartment_id);

    // 2. Consultar tickets y consumos asociados a esos apartamentos
    const [tickets, selections] = await Promise.all([
      Ticket.find({ apartment_id: { $in: aptIds } }).sort({ createdAt: -1 }),
      GuestSelection.find({ apartment_id: { $in: aptIds } }).sort({ createdAt: -1 })
    ]);

    // 3. Mapear y estructurar la respuesta para el dashboard
    const dashboardData = apartments.map(apt => {
      const aptTickets = tickets.filter(t => t.apartment_id === apt.apartment_id);
      const aptSelections = selections.filter(s => s.apartment_id === apt.apartment_id);

      const pendingTickets = aptTickets.filter(t => t.status === 'Pendiente' || t.status === 'pending');
      const hasIssues = pendingTickets.some(t => t.type === 'issue' || t.category === 'Queja');
      
      let statusColor = apt.status || 'Activo';
      if (hasIssues) {
        statusColor = 'Urgente';
      } else if (pendingTickets.length > 0) {
        statusColor = 'Pendiente';
      }

      return {
        apartment_id: apt.apartment_id,
        name: apt.name,
        status: statusColor,
        wifi_config: apt.wifi_config || apt.wifi || 'Configurado',
        instructions: apt.instructions || '',
        rules: apt.rules || '',
        ical_url: apt.ical_url || '',
        guest_url: apt.guest_url || `https://huesped1.prestigecloser.com/guest.html?id=${apt.apartment_id}`,
        qr_code: apt.qr_code || '',
        pending_tickets: aptTickets.map(t => ({
          _id: t._id,
          category: t.category || t.type || 'General',
          description: t.description || t.message || '',
          status: t.status === 'pending' ? 'Pendiente' : (t.status || 'Pendiente'),
          host_response: t.host_response || t.response || '',
          createdAt: t.createdAt
        })),
        guest_selections: aptSelections.map(s => ({
          _id: s._id,
          item_name: s.item_name || s.title || s.name || 'Selección',
          category: s.category || 'Servicio/Minibar',
          price: s.price || 0,
          createdAt: s.createdAt
        }))
      };
    });

    res.json({ dashboard: dashboardData });
  } catch (error) {
    console.error('Error al obtener datos del dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 5. CONFIGURACIÓN DE ARCHIVOS ESTÁTICOS Y VISTAS HTML
// ==========================================

app.use(express.static(path.join(__dirname)));

app.get('/guest.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'guest.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'guest.html'));
});

// Middleware para capturar cualquier ruta no encontrada dentro de /api/
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint no encontrado o método no permitido.' });
});

// ==========================================
// 6. INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
