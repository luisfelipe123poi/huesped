/**
 * Concierge Digital - Servidor Backend Todo-En-Uno
 * Creado para despliegue en Render.com
 * 
 * Incluye:
 * - Conexión a MongoDB (Mongoose)
 * - CRUD de Propiedades y Generación de QR (QRcode)
 * - Motor 1: Chat Concierge con OpenAI API (GPT-4o-mini)
 * - Motor 2: Discovery / Lugares Cercanos (Google Places API / Fallback Mock)
 * - Motor 3: Solicitudes de Ayuda / Tickets
 * - "Resumen de Hoy" para el Centro de Operaciones impulsado por IA
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const OpenAI = require('openai');
const QRCode = require('qrcode');
const { Client } = require('@googlemaps/google-maps-services-js');

// ==========================================
// 1. CONFIGURACIÓN INICIAL & INSTANCIAS
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'fake_key' });
const googleMapsClient = new Client({});

// Conexión a MongoDB Atlas
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/concierge_db';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('🍃 Conectado exitosamente a MongoDB Atlas'))
  .catch(err => console.error('❌ Error de conexión a MongoDB:', err.message));

// ==========================================
// 2. MODELOS DE DATOS (MONGOOSE SCHEMAS)
// ==========================================

// Esquema de Propiedad / Apartamento
const PropertySchema = new mongoose.Schema({
  name: { type: String, required: true },               // Ej: "Ocean View 1204"
  address: { type: String, required: true },            // Ej: "Bocagrande Carrera 1 #12-04"
  location: {
    lat: { type: Number, default: 10.4002 },            // Latitud por defecto (Cartagena)
    lng: { type: Number, default: -75.5524 }            // Longitud por defecto (Cartagena)
  },
  wifi: {
    network: { type: String, required: true },          // Ej: "Ocean_Guest_1204"
    password: { type: String, required: true }          // Ej: "beach2026"
  },
  houseRules: { type: String, default: "" },             // Instrucciones de A/C, Checkout, TV, etc.
  whatsappAlerts: { type: String, required: true },     // Teléfono para recibir alertas (+57...)
  ownerId: { type: String, default: "default_owner" },  // Identificador del propietario
  qrCodeUrl: { type: String }                           // QR base64 generado automáticamente
}, { timestamps: true });

const Property = mongoose.model('Property', PropertySchema);

// Esquema de Ticket / Solicitud de Servicio
const ServiceTicketSchema = new mongoose.Schema({
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
  guestName: { type: String, default: 'Huésped' },
  category: { 
    type: String, 
    enum: ['Toallas', 'Limpieza', 'Mantenimiento', 'Amenities', 'Checkout', 'Otros'], 
    required: true 
  },
  description: { type: String, required: true },
  status: { type: String, enum: ['Pendiente', 'En Proceso', 'Resuelto'], default: 'Pendiente' },
  priority: { type: String, enum: ['Baja', 'Media', 'Alta'], default: 'Media' }
}, { timestamps: true });

const ServiceTicket = mongoose.model('ServiceTicket', ServiceTicketSchema);

// ==========================================
// 3. RUTAS Y ENDPOINTS DE LA API
// ==========================================

// --- HEALTH CHECK (Requerido para Render.com) ---
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime(), timestamp: new Date() });
});

// ------------------------------------------
// PROPIEDADES (CRUD + QR GENERATOR)
// ------------------------------------------

// Crear nueva propiedad + Generar Código QR automáticamente
app.post('/api/properties', async (req, res) => {
  try {
    const { name, address, location, wifi, houseRules, whatsappAlerts, ownerId } = req.body;

    const newProperty = new Property({
      name,
      address,
      location,
      wifi,
      houseRules,
      whatsappAlerts,
      ownerId: ownerId || 'default_owner'
    });

    // Guardar para obtener el ID de MongoDB
    await newProperty.save();

    // Generar la URL pública que escaneará el huésped y crear el QR en Data URL (base64)
    const guestAppUrl = process.env.FRONTEND_URL 
      ? `${process.env.FRONTEND_URL}/stay/${newProperty._id}` 
      : `https://app.tuconcierge.com/stay/${newProperty._id}`;

    const qrDataUrl = await QRCode.toDataURL(guestAppUrl);
    newProperty.qrCodeUrl = qrDataUrl;
    await newProperty.save();

    res.status(201).json({ success: true, property: newProperty, guestUrl: guestAppUrl });
  } catch (error) {
    console.error('Error al crear propiedad:', error);
    res.status(500).json({ error: 'Error al registrar la propiedad', details: error.message });
  }
});

// Obtener todas las propiedades de un propietario
app.get('/api/properties', async (req, res) => {
  try {
    const { ownerId } = req.query;
    const filter = ownerId ? { ownerId } : {};
    const properties = await Property.find(filter).sort({ createdAt: -1 });
    res.json({ properties });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo propiedades' });
  }
});

// Obtener detalle de una propiedad por ID (Usado por la Web App del Huésped)
app.get('/api/properties/:id', async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ error: 'Propiedad no encontrada' });
    res.json({ property });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo detalle de la propiedad' });
  }
});

// ------------------------------------------
// MOTOR 1: CHAT CONCIERGE IA (OPENAI API)
// ------------------------------------------
app.post('/api/concierge/chat', async (req, res) => {
  try {
    const { propertyId, userMessage, conversationHistory } = req.body;

    if (!propertyId || !userMessage) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos (propertyId, userMessage)' });
    }

    const property = await Property.findById(propertyId);
    if (!property) return res.status(404).json({ error: 'Propiedad no encontrada' });

    // System Prompt Dinámico cargando la configuración del apartamento
    const systemPrompt = `
Eres el Concierge Digital 5 estrellas del apartamento "${property.name}".
Tu misión es brindar atención cálida, impecable, precisa y concisa a los huéspedes.

INFORMACIÓN DE LA PROPIEDAD:
- Nombre: ${property.name}
- Dirección: ${property.address}
- Red WiFi: ${property.wifi.network}
- Clave WiFi: ${property.wifi.password}
- Reglas e instrucciones especiales del apartamento:
${property.houseRules || "Sin instrucciones específicas adicionales registradas por el anfitrión."}

REGLAS DE CONDUCTA Y RESPUESTA:
1. Responde siempre en el mismo idioma en el que escribe el huésped.
2. Mantén las respuestas cortas, estructuradas y fáciles de leer en una pantalla móvil.
3. Si el huésped pregunta por servicios físicos (p. ej., solicitar toallas extra, mantenimiento, aseo o ayuda urgente), indícale amablemente que puede tocar la opción "Solicitar Ayuda" en el menú para crear una solicitud directa con el equipo.
4. Sé servicial, hospitalario y profesional en todo momento.
`;

    // Historial previo de mensajes si existe
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(conversationHistory || []),
      { role: 'user', content: userMessage }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.7,
      max_tokens: 350
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });

  } catch (error) {
    console.error('Error en Concierge IA:', error);
    res.status(500).json({ error: 'Error procesando la consulta con la IA', details: error.message });
  }
});

// ------------------------------------------
// MOTOR 2: DISCOVERY / LUGARES CERCANOS
// ------------------------------------------
app.get('/api/discovery/nearby/:propertyId', async (req, res) => {
  try {
    const { type } = req.query; // 'restaurant', 'supermarket', 'pharmacy', 'hospital', 'beach', etc.
    const property = await Property.findById(req.params.propertyId);

    if (!property || !property.location) {
      return res.status(400).json({ error: 'Ubicación de propiedad no válida' });
    }

    // Si existe API Key de Google Maps, hacer consulta real a Google Places
    if (process.env.GOOGLE_PLACES_API_KEY) {
      const response = await googleMapsClient.placesNearby({
        params: {
          location: [property.location.lat, property.location.lng],
          radius: 1500, // 1.5 km a la redonda
          type: type || 'restaurant',
          key: process.env.GOOGLE_PLACES_API_KEY
        }
      });

      const places = response.data.results.slice(0, 8).map(p => ({
        name: p.name,
        rating: p.rating,
        userRatingsTotal: p.user_ratings_total,
        vicinity: p.vicinity,
        openNow: p.opening_hours ? p.opening_hours.open_now : null,
        location: p.geometry.location
      }));

      return res.json({ places });
    }

    // Fallback Inteligente / Mock Data si no hay Google Places API Key
    const mockData = {
      restaurant: [
        { name: 'Restaurante El Faro', rating: 4.8, vicinity: 'A 200m del apartamento', openNow: true },
        { name: 'Trattoria & Pizza Bella', rating: 4.6, vicinity: 'A 350m del apartamento', openNow: true },
        { name: 'Café del Mar', rating: 4.7, vicinity: 'A 500m del apartamento', openNow: false }
      ],
      supermarket: [
        { name: 'Supermercado Exito / Carulla', rating: 4.5, vicinity: 'A 150m del apartamento', openNow: true },
        { name: 'Tienda de Conveniencia 24/7', rating: 4.2, vicinity: 'En la esquina', openNow: true }
      ],
      pharmacy: [
        { name: 'Droguería & Farmacia San Pablo', rating: 4.7, vicinity: 'A 100m del apartamento', openNow: true }
      ]
    };

    const places = mockData[type] || mockData['restaurant'];
    res.json({ places, isMock: true });

  } catch (error) {
    console.error('Error en Discovery API:', error);
    res.status(500).json({ error: 'Error obteniendo lugares cercanos' });
  }
});

// ------------------------------------------
// MOTOR 3: SOLICITUDES DE SERVICIO & TICKETS
// ------------------------------------------

// Crear un nuevo ticket de ayuda
app.post('/api/tickets', async (req, res) => {
  try {
    const { propertyId, guestName, category, description, priority } = req.body;

    const property = await Property.findById(propertyId);
    if (!property) return res.status(404).json({ error: 'Propiedad no encontrada' });

    const newTicket = new ServiceTicket({
      propertyId,
      guestName: guestName || 'Huésped',
      category,
      description,
      priority: priority || 'Media'
    });

    await newTicket.save();

    // Log de simulación de alerta inmediata a WhatsApp
    console.log(`
🔔 ----------------------------------------------------
🔔 NUEVA ALERTA DE SERVICIO RECIBIDA:
🏢 Propiedad: ${property.name}
🧺 Categoría: ${category}
💬 Descripción: ${description}
👤 Huésped: ${guestName || 'Huésped'}
📱 Notificación enviada a WhatsApp: ${property.whatsappAlerts}
🔔 ----------------------------------------------------
    `);

    res.status(201).json({ success: true, ticket: newTicket });
  } catch (error) {
    console.error('Error al crear ticket:', error);
    res.status(500).json({ error: 'Error registrando la solicitud' });
  }
});

// Listar tickets (para el Centro de Operaciones del Propietario)
app.get('/api/tickets', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const tickets = await ServiceTicket.find(filter).populate('propertyId').sort({ createdAt: -1 });
    res.json({ tickets });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo lista de tickets' });
  }
});

// Actualizar estado de un ticket (Atender / Resolver)
app.patch('/api/tickets/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const ticket = await ServiceTicket.findByIdAndUpdate(
      req.params.id, 
      { status }, 
      { new: true }
    );
    res.json({ success: true, ticket });
  } catch (error) {
    res.status(500).json({ error: 'Error actualizando el ticket' });
  }
});

// ------------------------------------------
// DASHBOARD: RESUMEN DE HOY CON IA
// ------------------------------------------
app.get('/api/owner/daily-summary', async (req, res) => {
  try {
    const totalProperties = await Property.countDocuments();
    const pendingTickets = await ServiceTicket.find({ status: 'Pendiente' }).populate('propertyId');
    const resolvedTodayCount = await ServiceTicket.countDocuments({ status: 'Resuelto' });

    // Invocación a la IA para redactar el resumen matutino personalizado
    const prompt = `
Eres un asistente ejecutivo de IA para un propietario inmobiliario que gestiona ${totalProperties} apartamentos de renta corta.
Redacta un saludo matutino elegante, motivador y conciso de 1 solo párrafo en español para el panel de control.

DATOS ACTUALES DE LA OPERACIÓN:
- Total propiedades activas: ${totalProperties}
- Solicitudes pendientes de atención: ${pendingTickets.length}
- Solicitudes resueltas hoy: ${resolvedTodayCount}
- Detalle de incidentes/pendientes actuales: ${JSON.stringify(pendingTickets.map(t => ({
    propiedad: t.propertyId ? t.propertyId.name : 'Desconocida',
    categoria: t.category,
    detalle: t.description
  })))}

Formatea el texto resaltando con comillas o negritas los números y los apartamentos con atención requerida.
`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6
    });

    const aiSummary = completion.choices[0].message.content;

    res.json({
      summary: aiSummary,
      metrics: {
        totalProperties,
        pendingTicketsCount: pendingTickets.length,
        resolvedTodayCount
      },
      pendingTickets
    });

  } catch (error) {
    console.error('Error generando resumen de hoy:', error);
    res.status(500).json({ error: 'Error generando el resumen operativo con la IA' });
  }
});

// ==========================================
// 4. ARRANCAR EL SERVIDOR
// ==========================================
app.listen(PORT, () => {
  console.log(`
🚀 ====================================================
🚀 SERVIDORE CONCIERGE DIGITAL CORRIENDO
🌐 Puerto local/Render: ${PORT}
🏥 Health Check Endpoint: http://localhost:${PORT}/health
🚀 ====================================================
  `);
});
