require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
app.use(bodyParser.json());

// 🌐 Tokens
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 🔹 Inicializar cliente OpenAI
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// 📥 Leer data.json y SystemPrompt.txt
const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
const promoData = JSON.parse(fs.readFileSync('./promoData.json', 'utf8'));
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf8');

// 🗂 Variables de control
let estadoUsuario = {};
let avisoEnviado = {};
let okEnviado = {};
let provinciaPagosEnviados = {};
let memoriaConversacion = {}; // 🆕 Memoria por usuario
let primerMensaje = {}; // 🆕 Bandera para saber si es el primer mensaje del usuario
let timersInactividad = {}; // ✅ NUEVO: control de inactividad por usuario
let contadorMensajesAsesor = {}; // ✅ NUEVO: Contador de mensajes por asesoría

// 🌐 WEBHOOK
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verificado correctamente');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// 📩 MENSAJES ENTRANTES

// 🆕 Funciones para gestionar la inactividad del usuario
function reiniciarTimerInactividad(senderId) {
    if (timersInactividad[senderId]) {
        clearTimeout(timersInactividad[senderId].timer10);
        clearTimeout(timersInactividad[senderId].timer12);
    }

    timersInactividad[senderId] = {};

    timersInactividad[senderId].timer10 = setTimeout(() => {
        enviarAvisoInactividad(senderId);
    }, 10 * 60 * 1000);

    timersInactividad[senderId].timer12 = setTimeout(() => {
        finalizarSesion(senderId);
    }, 12 * 60 * 1000);
}

async function enviarAvisoInactividad(senderId) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderId },
            message: {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "button",
                        text: "¿Podemos ayudarte en algo más? 😊 También puedes continuar tu pedido por WhatsApp:",
                        buttons: [
                            { type: "web_url", url: "https://wa.me/51904805167", title: "📞 Continuar por WhatsApp" }
                        ]
                    }
                }
            }
        });
    } catch (error) {
        console.error('❌ Error enviando aviso de inactividad:', error.response?.data || error.message);
    }
}

async function finalizarSesion(senderId) {
    try {
        delete estadoUsuario[senderId];
        delete memoriaConversacion[senderId];

        await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderId },
            message: { text: "⏳ Tu sesión ha terminado. ¡Gracias por visitar Tiendas Megan!" }
        });
    } catch (error) {
        console.error('❌ Error finalizando sesión:', error.response?.data || error.message);
    }
}
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    body.entry.forEach(async (entry) => {
      const webhookEvent = entry.messaging[0];
      const senderId = webhookEvent.sender.id;

      // ✅ QUICK REPLY
      if (webhookEvent.message && webhookEvent.message.quick_reply) {
        const payload = webhookEvent.message.quick_reply.payload;

        if (payload.startsWith('COMPRAR_')) {
          enviarPreguntaUbicacion(senderId);
          return;
        }

        if (payload === 'UBICACION_LIMA') {
          estadoUsuario[senderId] = 'ESPERANDO_DATOS_LIMA';
          avisoEnviado[senderId] = false;
          okEnviado[senderId] = false;
          enviarMensajeTexto(senderId,
            "😊 Claro que sí. Por favor, para enviar su pedido indíquenos los siguientes datos:\n\n" +
            "✅ Nombre completo ✍️\n" +
            "✅ Número de WhatsApp 📱\n" +
            "✅ Dirección exacta 📍\n" +
            "✅ Una referencia de cómo llegar a su domicilio 🏠");
          return;
        }

        if (payload === 'UBICACION_PROVINCIA') {
          estadoUsuario[senderId] = 'ESPERANDO_DATOS_PROVINCIA';
          avisoEnviado[senderId] = false;
          okEnviado[senderId] = false;
          provinciaPagosEnviados[senderId] = false;
          enviarMensajeTexto(senderId,
            "😊 Claro que sí. Por favor, permítanos los siguientes datos para programar su pedido:\n\n" +
            "✅ Nombre completo ✍️\n" +
            "✅ DNI 🪪\n" +
            "✅ Número de WhatsApp 📱\n" +
            "✅ Agencia Shalom que le queda más cerca 🚚");
          return;
        }
      }

// ✅ MENSAJE DE TEXTO NORMAL (LÓGICA CORREGIDA)
if (webhookEvent.message && webhookEvent.message.text) {
  reiniciarTimerInactividad(senderId); // 🆕 Reiniciamos timers de inactividad
  const mensaje = webhookEvent.message.text.trim().toLowerCase();

  // 🎯 Si el usuario está en modo asesor, enviamos la consulta a ChatGPT
  if (estadoUsuario[senderId] === 'ASESOR') {
    if (mensaje === 'salir') {
      delete estadoUsuario[senderId];
      delete memoriaConversacion[senderId];
      delete contadorMensajesAsesor[senderId]; // ✅ Limpiamos el contador
      enviarMensajeTexto(senderId, "🚪 Has salido del chat con asesor. Volviendo al menú principal...");
      enviarMenuPrincipal(senderId);
      return;
    }

    await enviarConsultaChatGPT(senderId, mensaje);
    return;
  }

  // ✅ RESPUESTA A “GRACIAS”
  if (/^(gracias|muchas gracias|mil gracias|gracias!|gracias :\))$/i.test(mensaje)) {
    enviarMensajeTexto(senderId, "😄 ¡Gracias a usted! Estamos para servirle.");
    return;
  }

  // 🎯 FLUJOS DE COMPRA
  if (estadoUsuario[senderId] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[senderId] === 'ESPERANDO_DATOS_PROVINCIA') {
    manejarFlujoCompra(senderId, mensaje);
    return;
  }

  // 🎯 DISPARADORES DE INFO
  if (mensaje.includes('me interesa este reloj exclusivo')) {
    enviarInfoPromo(senderId, promoData.reloj1);
    return;
  }
  if (mensaje.includes('me interesa este reloj de lujo')) {
    enviarInfoPromo(senderId, promoData.reloj2);
    return;
  }

  if (mensaje.includes('ver otros modelos')) {
    enviarMenuPrincipal(senderId);
    return;
  }

  if (mensaje.includes('hola')) {
    enviarMenuPrincipal(senderId);
    return;
  }

  // ✅ Si no hay ningún trigger, ChatGPT responde (segunda interacción en adelante)
  if (primerMensaje[senderId]) {
    await enviarConsultaChatGPT(senderId, mensaje);
    return;
  } else {
    primerMensaje[senderId] = true; // Marcamos la primera interacción
  }
}

      // ✅ POSTBACKS}
      if (webhookEvent.postback) {
        manejarPostback(senderId, webhookEvent.postback.payload);
      }
    });

    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// 🔹 MANEJAR POSTBACKS
function manejarPostback(senderId, payload) {
  switch (payload) {
    case "CABALLEROS":
      enviarSubmenuTipoReloj(senderId, "CABALLEROS");
      break;
    case "DAMAS":
      enviarSubmenuTipoReloj(senderId, "DAMAS");
      break;

    // ✅ ACTIVAR MODO ASESOR
    case "ASESOR":
      estadoUsuario[senderId] = 'ASESOR';
      memoriaConversacion[senderId] = [];
      contadorMensajesAsesor[senderId] = 0; // ✅ Reiniciamos contador al entrar
      enviarMensajeConBotonSalir(senderId,
        "😊 ¡Claro que sí! Estamos listos para responder todas sus dudas y consultas. Por favor, escríbenos qué te gustaría saber ✍️");
      break;

    // 📥 CATÁLOGOS
    case "CABALLEROS_AUTO":
      enviarCatalogo(senderId, "caballeros_automaticos");
      break;
    case "CABALLEROS_CUARZO":
      enviarCatalogo(senderId, "caballeros_cuarzo");
      break;
    case "DAMAS_AUTO":
      enviarCatalogo(senderId, "damas_automaticos");
      break;
    case "DAMAS_CUARZO":
      enviarCatalogo(senderId, "damas_cuarzo");
      break;

    case "VER_MODELOS":
      enviarMenuPrincipal(senderId);
      break;

    // ✅ SALIR DEL MODO ASESOR
    case "SALIR_ASESOR":
      delete estadoUsuario[senderId];
      delete memoriaConversacion[senderId];
      delete contadorMensajesAsesor[senderId]; // ✅ Borramos contador
      enviarMensajeTexto(senderId, "🚪 Has salido del chat con asesor.");
      enviarMenuPrincipal(senderId);
      break;

    default:
      if (payload.startsWith("COMPRAR_")) {
        enviarPreguntaUbicacion(senderId);
      } else {
        enviarMensajeTexto(senderId, "❓ No entendí su selección, por favor intente de nuevo.");
      }
  }
}


// 🔹 CONSULTAR CHATGPT CON MEMORIA (NUEVA LÓGICA DE TRIGGERS)
async function enviarConsultaChatGPT(senderId, mensajeCliente) {
  try {
    if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];

    memoriaConversacion[senderId].push({ role: "user", content: mensajeCliente });

    // ✅ Sumamos interacción
    if (!contadorMensajesAsesor[senderId]) contadorMensajesAsesor[senderId] = 0;
    contadorMensajesAsesor[senderId]++;

    const contexto = [
      { role: "system", content: `${systemPrompt}

Aquí tienes los datos del catálogo: ${JSON.stringify(data, null, 2)}` },
      ...memoriaConversacion[senderId]
    ];

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: contexto
    });

    const respuesta = completion.choices[0].message.content.trim();
    memoriaConversacion[senderId].push({ role: "assistant", content: respuesta });

    // ✅ Detectar triggers de ChatGPT
    if (respuesta.startsWith("MOSTRAR_MODELO:")) {
      const codigo = respuesta.split(":")[1].trim();
      const producto = Object.values(data).flat().find(p => p.codigo === codigo);
      
      if (producto) {
        await enviarInfoPromo(senderId, producto); // 📸 Envía imagen + info
      } else {
        await enviarMensajeTexto(senderId, "😔 Lo siento, no encontramos ese modelo en nuestra base de datos.");
      }
      return;
    }

    if (respuesta.startsWith("MOSTRAR_CATALOGO:")) {
      const categoria = respuesta.split(":")[1].trim();
      await enviarCatalogo(senderId, categoria);
      return;
    }

    // ✅ Si GPT pide preguntar género para catálogo
    if (respuesta === "PEDIR_CATALOGO") {
      await enviarMensajeTexto(senderId, "😊 Claro que sí. ¿El catálogo que desea ver es para caballeros o para damas?");
      estadoUsuario[senderId] = "ESPERANDO_GENERO";
      return;
    }

    // ✅ Si GPT pide preguntar tipo (después de género)
    if (respuesta.startsWith("PREGUNTAR_TIPO:")) {
      const genero = respuesta.split(":")[1].trim();
      estadoUsuario[senderId] = `ESPERANDO_TIPO_${genero.toUpperCase()}`;
      await enviarSubmenuTipoReloj(senderId, genero.toUpperCase());
      return;
    }

    // ✅ Si no hay trigger, enviamos la respuesta normal como antes
    await enviarMensajeConBotonSalir(senderId, respuesta);

  } catch (error) {
    console.error('❌ Error en consulta a ChatGPT:', error);
    await enviarMensajeTexto(senderId, "⚠️ Lo siento, hubo un problema al conectarme con el asesor. Intenta nuevamente en unos minutos.");
  }
}


// 🔹 MANEJAR FLUJO DE COMPRA (igual que antes)
async function manejarFlujoCompra(senderId, mensaje) {
  const tieneCelular = /\b9\d{8}\b/.test(mensaje);
  const tieneNombre = /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)(\s+[A-ZÁÉÍÓÚÑ]?[a-záéíóúñ]+){1,3}$/.test(mensaje);
  const tieneDireccion = /(jirón|jr\.|avenida|av\.|calle|pasaje|mz|mza|lote|urb\.|urbanización)/i.test(mensaje);
  const tieneDNI = /\b\d{8}\b/.test(mensaje);

  if (estadoUsuario[senderId] === 'ESPERANDO_DATOS_PROVINCIA') {
    if (!tieneNombre) return enviarMensajeTexto(senderId, "📌 Por favor envíe su nombre completo.");
    if (!tieneDNI) return enviarMensajeTexto(senderId, "📌 Su DNI debe tener 8 dígitos. Por favor, envíelo correctamente.");
    if (!tieneCelular) return enviarMensajeTexto(senderId, "📌 Su número de WhatsApp debe tener 9 dígitos y comenzar con 9.");

    await enviarMensajeTexto(senderId,
      "✅ Su orden ha sido confirmada ✔\nEnvío de: 1 Reloj Premium\n" +
      "👉 Forma: Envío a recoger en Agencia Shalom\n" +
      "👉 Datos recibidos correctamente.\n");

    await enviarMensajeTexto(senderId,
      "😊 Estimado cliente, para enviar su pedido necesitamos un adelanto simbólico de 20 soles por motivo de seguridad.\n\n" +
      "📱 YAPE: 979 434 826 (Paulina Gonzales Ortega)\n" +
      "🏦 BCP: 19303208489096\n" +
      "🏦 CCI: 00219310320848909613\n\n" +
      "📤 Envíe la captura de su pago aquí para registrar su adelanto.");
    provinciaPagosEnviados[senderId] = true;
    delete estadoUsuario[senderId];
    return;
  }

  if (estadoUsuario[senderId] === 'ESPERANDO_DATOS_LIMA') {
    if (!tieneNombre) return enviarMensajeTexto(senderId, "📌 Por favor envíe su nombre completo.");
    if (!tieneCelular) return enviarMensajeTexto(senderId, "📌 Su número de WhatsApp debe tener 9 dígitos y comenzar con 9.");
    if (!tieneDireccion) return enviarMensajeTexto(senderId, "📌 Su dirección debe incluir calle, avenida, jirón o pasaje.");

    await enviarMensajeTexto(senderId,
      "✅ Su orden ha sido confirmada ✔\nEnvío de: 1 Reloj Premium\n" +
      "👉 Forma: Envío express a domicilio\n" +
      "👉 Datos recibidos correctamente.\n" +
      "💰 El costo incluye S/10 adicionales por envío a domicilio.");

    delete estadoUsuario[senderId];
    return;
  }

  if (!avisoEnviado[senderId]) {
    await enviarMensajeTexto(senderId,
      "📌 Por favor, asegúrese de enviar sus datos correctos (nombre, WhatsApp, DNI/dirección y agencia Shalom).");
    avisoEnviado[senderId] = true;
  }
}

// 🔹 ENVIAR MENSAJE TEXTO
async function enviarMensajeTexto(senderId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: senderId },
      message: { text }
    });
  } catch (error) {
    console.error('❌ Error enviando mensaje:', error.response?.data || error.message);
  }
}

// 🔹 ENVIAR MENSAJE + BOTÓN (MODIFICADO)
async function enviarMensajeConBotonSalir(senderId, text) {
  try {
    // ✅ Antes de 6 interacciones, solo enviamos el texto normal
    if (!contadorMensajesAsesor[senderId] || contadorMensajesAsesor[senderId] < 6) {
      await enviarMensajeTexto(senderId, text);
      return;
    }

    // ✅ Después de 6 interacciones, mostramos el botón “↩️ Volver al inicio”
    await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: text,
            buttons: [
              { type: "postback", title: "↩️ Volver al inicio", payload: "SALIR_ASESOR" }
            ]
          }
        }
      }
    });
  } catch (error) {
    console.error('❌ Error enviando mensaje con botón salir:', error.response?.data || error.message);
  }
}

// 🔹 ENVIAR INFO DE PROMO (con botones VERTICALES)
async function enviarInfoPromo(senderId, producto) {
  try {
    // 1️⃣ Enviar la imagen del producto
    await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: "image",
          payload: { url: producto.imagen, is_reusable: true }
        }
      }
    });

    // 2️⃣ Enviar texto + botones en VERTICAL
    await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: `${producto.nombre}\n${producto.descripcion}\n💰 Precio: S/${producto.precio}`,
            buttons: [
              {
                type: "postback",
                title: "🛍️ Comprar ahora",
                payload: `COMPRAR_${producto.codigo}`
              },
              {
                type: "web_url",
url: "https://wa.me/51904805167?text=Hola%20quiero%20comprar%20este%20modelo",
title: "📞 Comprar por WhatsApp"

              },
              {
                type: "postback",
                title: "📖 Ver otros modelos",
                payload: "VER_MODELOS"
              }
            ]
          }
        }
      }
    });

  } catch (error) {
    console.error('❌ Error enviando info promo:', error.response?.data || error.message);
  }
}

// 🔹 ENVIAR MENÚ PRINCIPAL (igual que antes)
async function enviarMenuPrincipal(senderId) {
  try {
    await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: "👋 ¡Hola! Bienvenido a Tiendas Megan\n⌚💎 Descubre tu reloj ideal o el regalo perfecto 🎁\nElige una opción para ayudarte 👇",
            buttons: [
              { type: "postback", title: "⌚ Para Caballeros", payload: "CABALLEROS" },
              { type: "postback", title: "🕒 Para Damas", payload: "DAMAS" },
              { type: "postback", title: "💬 Hablar con Asesor", payload: "ASESOR" }
            ]
          }
        }
      }
    });
  } catch (error) {
    console.error('❌ Error enviando menú principal:', error.response?.data || error.message);
  }
}

// 🔹 SUBMENÚ AUTOMÁTICOS / CUARZO (igual que antes)
async function enviarSubmenuTipoReloj(senderId, genero) {
  let texto = genero === "CABALLEROS" 
    ? "🔥 ¡Excelente elección! ¿Qué tipo de reloj para caballeros le interesa?"
    : "🔥 ¡Excelente elección! ¿Qué tipo de reloj para damas le interesa?";

  let payloadAuto = genero === "CABALLEROS" ? "CABALLEROS_AUTO" : "DAMAS_AUTO";
  let payloadCuarzo = genero === "CABALLEROS" ? "CABALLEROS_CUARZO" : "DAMAS_CUARZO";

  try {
    await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: texto,
            buttons: [
              { type: "postback", title: "⌚ Automáticos ⚙️", payload: payloadAuto },
              { type: "postback", title: "🕑 De cuarzo ✨", payload: payloadCuarzo }
            ]
          }
        }
      }
    });
  } catch (error) {
    console.error('❌ Error enviando submenú tipo de reloj:', error.response?.data || error.message);
  }
}

// 🔹 ENVIAR CATÁLOGO (igual que antes)
async function enviarCatalogo(senderId, categoria) {
  try {
    const listaProductos = data[categoria];

    if (!listaProductos || listaProductos.length === 0) {
      enviarMensajeTexto(senderId, "❌ No tenemos productos en esta categoría por ahora.");
      return;
    }

    for (let producto of listaProductos) {
      await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
        recipient: { id: senderId },
        message: {
          attachment: { type: "image", payload: { url: producto.imagen, is_reusable: true } }
        }
      });

      await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
        recipient: { id: senderId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: `${producto.nombre}\n${producto.descripcion}\n💰 Precio: S/${producto.precio}`,
              buttons: [
                { type: "postback", title: "🛍️ Comprar ahora", payload: `COMPRAR_${producto.codigo}` },
                { type: "web_url", url: "https://wa.me/51904805167?text=Hola%20quiero%20comprar%20este%20modelo", title: "📞 Comprar por WhatsApp" },
                { type: "postback", title: "📖 Ver otros modelos", payload: "VER_MODELOS" }
              ]
            }
          }
        }
      });
    }
  } catch (error) {
    console.error('❌ Error enviando catálogo:', error.response?.data || error.message);
  }
}

// 🔹 PREGUNTAR LIMA O PROVINCIA (igual que antes)
async function enviarPreguntaUbicacion(senderId) {
  try {
    await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: senderId },
      message: {
        text: "😊 Por favor indíquenos, ¿su pedido es para Lima o para Provincia?",
        quick_replies: [
          { content_type: "text", title: "🏙 Lima", payload: "UBICACION_LIMA" },
          { content_type: "text", title: "🏞 Provincia", payload: "UBICACION_PROVINCIA" }
        ]
      }
    });
  } catch (error) {
    console.error('❌ Error enviando pregunta de ubicación:', error.response?.data || error.message);
  }
}

// 🚀 Servidor

// 🔥 FUNCIONES DE INACTIVIDAD 🔥
function reiniciarTimerInactividad(senderId) {
  limpiarTimers(senderId);
  const timer10 = setTimeout(async () => {
    await enviarBotonWhatsApp(senderId);
  }, 10 * 60 * 1000);

  const timer12 = setTimeout(async () => {
    await enviarMensajeTexto(senderId, "⏳ Su sesión ha terminado.");
    delete estadoUsuario[senderId];
    delete memoriaConversacion[senderId];
    delete contadorMensajesAsesor[senderId];
    limpiarTimers(senderId);
  }, 12 * 60 * 1000);

  timersInactividad[senderId] = { timer10, timer12 };
}

function limpiarTimers(senderId) {
  if (timersInactividad[senderId]) {
    clearTimeout(timersInactividad[senderId].timer10);
    clearTimeout(timersInactividad[senderId].timer12);
    delete timersInactividad[senderId];
  }
}

async function enviarBotonWhatsApp(senderId) {
  try {
    await axios.post(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: "¿Le gustaría que le ayudemos en algo más o desea continuar la conversación con un asesor por WhatsApp?",
            buttons: [
              { type: "web_url", url: "https://wa.me/51904805167", title: "📞 Continuar en WhatsApp" }
            ]
          }
        }
      }
    });
  } catch (error) {
    console.error('❌ Error enviando botón WhatsApp:', error.response?.data || error.message);
  }
}
// 🔥 FIN FUNCIONES DE INACTIVIDAD 🔥

app.listen(3000, () => console.log('🚀 Servidor corriendo en http://localhost:3000'));
