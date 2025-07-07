require('dotenv').config(); // Carga las variables de entorno desde .env
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const axios = require('axios'); // Para hacer llamadas a la API de deportes

const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURACIÓN DE SUPABASE ---
// Asegúrate de que estas credenciales son correctas.
const supabaseUrl = 'https://rbtosarnclkiylhaxfsp.supabase.co';
// ¡IMPORTANTE! Esta clave es pública (anon key). Para mayor seguridad en producción,
// se recomienda usar la "service_role key" en el backend y guardarla como variable de entorno.
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJidG9zYXJuY2xraXlsaGF4ZnNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE2OTU3NzEsImV4cCI6MjA2NzI3MTc3MX0.7hjrpCGVPKwU_nQc4AHt0bN_ZrAWTL_BgUAgWxmrkxo';
const supabase = createClient(supabaseUrl, supabaseKey);
// --- FIN DE LA CONFIGURACIÓN ---

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

app.post('/api/tickets', async (req, res) => {
    console.log("Recibida nueva solicitud para registrar ticket...");

    // 1. Extraer todos los datos del cuerpo de la solicitud
    const { importe, cuotaTotal, partidos, agente, cliente } = req.body;

    // Validación básica de los datos recibidos
    if (!importe || !cuotaTotal || !partidos || !Array.isArray(partidos)) {
        return res.status(400).json({ message: "Datos incompletos o en formato incorrecto." });
    }

    // --- INICIO DE LA TRANSACCIÓN SIMULADA ---
    try {
        // 2. Insertar el ticket principal con los nuevos campos
        const { data: ticketData, error: ticketError } = await supabase
            .from('Tickets')
            .insert({
                importe: importe,
                cuota_total: cuotaTotal,
                agente: agente,       // Nuevo campo
                cliente: cliente      // Nuevo campo
            })
            .select()
            .single();

        if (ticketError) {
            console.error("Error al insertar el ticket:", ticketError.message);
            // Si falla aquí, la transacción termina.
            throw new Error(`Error en Supabase al crear el ticket: ${ticketError.message}`);
        }

        const ticketId = ticketData.id;
        console.log(`Ticket principal guardado con ID: ${ticketId}`);

        // 3. Preparar e insertar todos los partidos
        const partidosParaInsertar = partidos.map(p => ({
            ticket_id: ticketId,
            partido: p.partido,
            fecha_hora: p.fechaHora, // Se guarda como texto, ya que puede ser 'N/A'
            mercado: p.mercado,
            seleccionado: p.seleccionado,
            cuota: parseFloat(p.cuota),
            tipo_apuesta: p.detalles.length > 0 ? 'crear_apuesta' : 'simple',
            es_en_vivo: p.enVivo,
            es_cuota_aumentada: p.cuotaAumentada // Nuevo campo
        }));

        const { data: insertedPartidos, error: partidosError } = await supabase
            .from('Partidos')
            .insert(partidosParaInsertar)
            .select();

        if (partidosError) {
            console.error("Error al insertar los partidos:", partidosError.message);
            // Si esto falla, intentamos borrar el ticket principal para no dejar datos huérfanos.
            await supabase.from('Tickets').delete().eq('id', ticketId);
            throw new Error(`Error en Supabase al guardar los partidos: ${partidosError.message}`);
        }
        
        console.log(`${insertedPartidos.length} partidos guardados.`);

        // 4. Preparar e insertar los detalles de "Crear Apuesta"
        const detallesParaInsertar = [];
        partidos.forEach((p, index) => {
            if (p.detalles.length > 0) {
                const partidoId = insertedPartidos[index].id; // Obtenemos el ID del partido recién insertado
                p.detalles.forEach(d => {
                    detallesParaInsertar.push({
                        partido_id: partidoId,
                        mercado: d.mercado,
                        seleccionado: d.seleccionado
                    });
                });
            }
        });

        if (detallesParaInsertar.length > 0) {
            const { error: detallesError } = await supabase
                .from('DetallesCrearApuesta')
                .insert(detallesParaInsertar);

            if (detallesError) {
                console.error("Error al insertar los detalles de 'Crear Apuesta':", detallesError.message);
                // Rollback manual: eliminar ticket y partidos asociados
                await supabase.from('Tickets').delete().eq('id', ticketId); 
                throw new Error(`Error en Supabase al guardar los detalles: ${detallesError.message}`);
            }
            console.log(`${detallesParaInsertar.length} detalles de 'Crear Apuesta' guardados.`);
        }

        // --- FIN DE LA TRANSACCIÓN SIMULADA ---
        res.status(201).json({ message: "Ticket registrado con éxito en Supabase", ticketId: ticketId });

    } catch (error) {
        console.error("--- ERROR DETALLADO DEL SERVIDOR ---");
        console.error(error);
        console.error("--- FIN ERROR DETALLADO ---");
        res.status(500).json({ message: "Error en el servidor al procesar el ticket.", error: error.message });
    }
});

// --- Funciones de Verificación por Mercado ---

function verifyResultadoDelPartido(partido, fixture) {
    const seleccionUsuario = partido.seleccionado.toLowerCase();
    const ganoLocal = fixture.teams.home.winner;
    const ganoVisitante = fixture.teams.away.winner;
    const esEmpate = ganoLocal === false && ganoVisitante === false;

    let resultadoApuesta = 'perdida';
    if ((seleccionUsuario.includes(fixture.teams.home.name.toLowerCase()) || seleccionUsuario === '1') && ganoLocal) {
        resultadoApuesta = 'ganada';
    } else if ((seleccionUsuario.includes(fixture.teams.away.name.toLowerCase()) || seleccionUsuario === '2') && ganoVisitante) {
        resultadoApuesta = 'ganada';
    } else if ((seleccionUsuario.includes('empate') || seleccionUsuario === 'x') && esEmpate) {
        resultadoApuesta = 'ganada';
    }
    
    const resultadoReal = `Final: ${fixture.teams.home.name} ${fixture.goals.home} - ${fixture.goals.away} ${fixture.teams.away.name}`;
    return { resultadoApuesta, resultadoReal };
}

function verifyTotalDeGoles(partido, fixture) {
    const seleccionGol = partido.seleccionado.toLowerCase();
    const partes = seleccionGol.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : (partes[0].includes('menos') ? 'menos' : null);
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));
    const totalGoles = fixture.goals.home + fixture.goals.away;

    if (!tipo || isNaN(valor)) {
        return { resultadoApuesta: `Selección '${partido.seleccionado}' no válida.`, resultadoReal: `Total Goles: ${totalGoles}` };
    }

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (totalGoles > valor) resultadoApuesta = 'ganada';
    } else if (tipo === 'menos') {
        if (totalGoles < valor) resultadoApuesta = 'ganada';
    }
    
    return { resultadoApuesta, resultadoReal: `Total Goles: ${totalGoles}` };
}

function verifyDobleOportunidad(partido, fixture) {
    const seleccionDO = partido.seleccionado.toLowerCase().replace(/\s/g, '');
    const ganoLocal = fixture.teams.home.winner;
    const ganoVisitante = fixture.teams.away.winner;
    const esEmpate = ganoLocal === false && ganoVisitante === false;

    let resultadoApuesta = 'perdida';
    if (seleccionDO === '1x' && (ganoLocal || esEmpate)) {
        resultadoApuesta = 'ganada';
    } else if (seleccionDO === 'x2' && (ganoVisitante || esEmpate)) {
        resultadoApuesta = 'ganada';
    } else if (seleccionDO === '12' && (ganoLocal || ganoVisitante)) {
        resultadoApuesta = 'ganada';
    }
    
    const resultadoReal = `Final: ${fixture.teams.home.name} ${fixture.goals.home} - ${fixture.goals.away} ${fixture.teams.away.name}`;
    return { resultadoApuesta, resultadoReal };
}

function verifyAmbosEquiposMarcan(partido, fixture) {
    const seleccion = partido.seleccionado.toLowerCase();
    const ambosMarcaron = fixture.goals.home > 0 && fixture.goals.away > 0;

    let resultadoApuesta = 'perdida';
    if ((seleccion === 'sí' || seleccion === 'si') && ambosMarcaron) {
        resultadoApuesta = 'ganada';
    } else if (seleccion === 'no' && !ambosMarcaron) {
        resultadoApuesta = 'ganada';
    }
    
    const resultadoReal = ambosMarcaron ? 'Ambos marcaron' : 'No marcaron ambos';
    return { resultadoApuesta, resultadoReal };
}

function verifyResultadoAlDescanso(partido, fixture) {
    const score = fixture.score.halftime;
    if (score.home === null || score.away === null) {
        return { resultadoApuesta: 'error_datos', resultadoReal: 'Datos del descanso no disponibles.' };
    }

    const seleccion = partido.seleccionado.toLowerCase();
    const ganoLocalDescanso = score.home > score.away;
    const ganoVisitanteDescanso = score.away > score.home;
    const esEmpateDescanso = score.home === score.away;

    let resultadoApuesta = 'perdida';
    if ((seleccion.includes(fixture.teams.home.name.toLowerCase()) || seleccion === '1') && ganoLocalDescanso) {
        resultadoApuesta = 'ganada';
    } else if ((seleccion.includes(fixture.teams.away.name.toLowerCase()) || seleccion === '2') && ganoVisitanteDescanso) {
        resultadoApuesta = 'ganada';
    } else if ((seleccion.includes('empate') || seleccion === 'x') && esEmpateDescanso) {
        resultadoApuesta = 'ganada';
    }

    const resultadoReal = `Descanso: ${fixture.teams.home.name} ${score.home} - ${score.away} ${fixture.teams.away.name}`;
    return { resultadoApuesta, resultadoReal };
}

function verifyTotalDeCorners(partido, fixture) {
    const stats = fixture.statistics;
    if (!stats || stats.length < 2) {
        return { resultadoApuesta: 'error_datos', resultadoReal: 'Estadísticas de córners no disponibles.' };
    }

    const cornersHomeStat = stats[0].statistics.find(s => s.type === 'Corner Kicks');
    const cornersAwayStat = stats[1].statistics.find(s => s.type === 'Corner Kicks');

    if (!cornersHomeStat || !cornersAwayStat || cornersHomeStat.value === null || cornersAwayStat.value === null) {
        return { resultadoApuesta: 'error_datos', resultadoReal: 'Datos de córners no disponibles.' };
    }

    const totalCorners = Number(cornersHomeStat.value) + Number(cornersAwayStat.value);
    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    
    const tipo = partes[0].includes('más') ? 'más' : (partes[0].includes('menos') ? 'menos' : null);
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));

    if (!tipo || isNaN(valor)) {
        return { resultadoApuesta: `Selección '${partido.seleccionado}' no válida.`, resultadoReal: `Total Córners: ${totalCorners}` };
    }

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (totalCorners > valor) resultadoApuesta = 'ganada';
    } else if (tipo === 'menos') {
        if (totalCorners < valor) resultadoApuesta = 'ganada';
    }

    return { resultadoApuesta, resultadoReal: `Total Córners: ${totalCorners}` };
}

function verifyApuestaSinEmpate(partido, fixture) {
    const esEmpate = fixture.teams.home.winner === false && fixture.teams.away.winner === false;
    const resultadoReal = `Final: ${fixture.teams.home.name} ${fixture.goals.home} - ${fixture.goals.away} ${fixture.teams.away.name}`;

    if (esEmpate) {
        return { resultadoApuesta: 'anulada', resultadoReal: `${resultadoReal} (Empate)` };
    }

    const seleccion = partido.seleccionado.toLowerCase();
    const ganoLocal = fixture.teams.home.winner;
    const ganoVisitante = fixture.teams.away.winner;

    let resultadoApuesta = 'perdida';
    if (ganoLocal && seleccion.includes(fixture.teams.home.name.toLowerCase())) {
        resultadoApuesta = 'ganada';
    } else if (ganoVisitante && seleccion.includes(fixture.teams.away.name.toLowerCase())) {
        resultadoApuesta = 'ganada';
    }

    return { resultadoApuesta, resultadoReal };
}

function verifyMarcadorExacto(partido, fixture) {
    const seleccion = partido.seleccionado.replace(/\s/g, ''); // "2-1"
    const [golesLocal, golesVisitante] = seleccion.split('-').map(Number);
    const resultadoReal = `Final: ${fixture.goals.home} - ${fixture.goals.away}`;

    if (isNaN(golesLocal) || isNaN(golesVisitante)) {
        return { resultadoApuesta: `Selección '${partido.seleccionado}' no válida.`, resultadoReal };
    }

    const resultadoApuesta = (fixture.goals.home === golesLocal && fixture.goals.away === golesVisitante) ? 'ganada' : 'perdida';
    return { resultadoApuesta, resultadoReal };
}

function verifyMitadFinal(partido, fixture) {
    const htScore = fixture.score.halftime;
    const ftScore = fixture.goals;
    const resultadoReal = `Descanso: ${htScore.home}-${htScore.away}, Final: ${ftScore.home}-${ftScore.away}`;

    if (htScore.home === null) {
        return { resultadoApuesta: 'error_datos', resultadoReal: 'Datos del descanso no disponibles.' };
    }

    const getWinner = (homeGoals, awayGoals) => {
        if (homeGoals > awayGoals) return 'local';
        if (awayGoals > homeGoals) return 'visitante';
        return 'empate';
    };

    const htWinner = getWinner(htScore.home, htScore.away);
    const ftWinner = getWinner(ftScore.home, ftScore.away);

    const seleccion = partido.seleccionado.toLowerCase().replace(/\s/g, '').split('/');
    if (seleccion.length !== 2) {
        return { resultadoApuesta: `Selección '${partido.seleccionado}' no válida.`, resultadoReal };
    }

    const mapSelection = (sel) => {
        if (sel.includes('local') || sel.includes(fixture.teams.home.name.toLowerCase()) || sel === '1') return 'local';
        if (sel.includes('visitante') || sel.includes(fixture.teams.away.name.toLowerCase()) || sel === '2') return 'visitante';
        if (sel.includes('empate') || sel.includes('x')) return 'empate';
        return 'invalido';
    };

    const selHT = mapSelection(seleccion[0]);
    const selFT = mapSelection(seleccion[1]);

    const resultadoApuesta = (htWinner === selHT && ftWinner === selFT) ? 'ganada' : 'perdida';
    return { resultadoApuesta, resultadoReal };
}

function verifyPrimerOultimoGol(partido, fixture, tipo) {
    const goalEvents = fixture.events.filter(e => e.type === 'Goal').sort((a, b) => a.time.elapsed - b.time.elapsed);
    
    if (goalEvents.length === 0) {
        const resultadoReal = "No hubo goles.";
        const resultadoApuesta = partido.seleccionado.toLowerCase().includes('no hay goles') ? 'ganada' : 'perdida';
        return { resultadoApuesta, resultadoReal };
    }

    const goal = tipo === 'primer' ? goalEvents[0] : goalEvents[goalEvents.length - 1];
    const teamName = goal.team.name;
    const resultadoReal = `${tipo === 'primer' ? 'Primer' : 'Último'} gol: ${teamName} (${goal.time.elapsed}')`;
    const resultadoApuesta = teamName.toLowerCase().includes(partido.seleccionado.toLowerCase()) ? 'ganada' : 'perdida';

    return { resultadoApuesta, resultadoReal };
}

function verifyEquipoTotalDeGoles(partido, fixture) {
    const mercado = partido.mercado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let teamGoals;
    let teamName;

    if (mercado.includes(homeTeamName)) {
        teamGoals = fixture.goals.home;
        teamName = fixture.teams.home.name;
    } else if (mercado.includes(awayTeamName)) {
        teamGoals = fixture.goals.away;
        teamName = fixture.teams.away.name;
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'No se pudo identificar el equipo en el mercado.' };
    }

    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : (partes[0].includes('menos') ? 'menos' : null);
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));
    const resultadoReal = `Goles de ${teamName}: ${teamGoals}`;

    if (!tipo || isNaN(valor)) {
        return { resultadoApuesta: `Selección '${partido.seleccionado}' no válida.`, resultadoReal };
    }

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (teamGoals > valor) resultadoApuesta = 'ganada';
    } else if (tipo === 'menos') {
        if (teamGoals < valor) resultadoApuesta = 'ganada';
    }

    return { resultadoApuesta, resultadoReal };
}

function verifyMargenDeVictoria(partido, fixture) {
    const ganoLocal = fixture.teams.home.winner;
    const ganoVisitante = fixture.teams.away.winner;
    const esEmpate = ganoLocal === false && ganoVisitante === false;
    const margen = Math.abs(fixture.goals.home - fixture.goals.away);
    const resultadoReal = `Margen: ${margen}, Ganador: ${esEmpate ? 'Empate' : (ganoLocal ? fixture.teams.home.name : fixture.teams.away.name)}`;

    const seleccion = partido.seleccionado.toLowerCase();

    if (seleccion.includes('empate')) {
        return { resultadoApuesta: esEmpate ? 'ganada' : 'perdida', resultadoReal };
    }

    const partes = seleccion.split(' por ');
    if (partes.length !== 2) return { resultadoApuesta: 'error_seleccion', resultadoReal };

    const equipoSeleccionado = partes[0];
    const golesSeleccionados = parseInt(partes[1].replace(' goles', '').replace(' gol', ''));

    if (isNaN(golesSeleccionados)) return { resultadoApuesta: 'error_seleccion', resultadoReal };

    let ganoEquipoSeleccionado = false;
    if (ganoLocal && equipoSeleccionado.includes(fixture.teams.home.name.toLowerCase())) {
        ganoEquipoSeleccionado = true;
    } else if (ganoVisitante && equipoSeleccionado.includes(fixture.teams.away.name.toLowerCase())) {
        ganoEquipoSeleccionado = true;
    }

    const resultadoApuesta = (ganoEquipoSeleccionado && margen === golesSeleccionados) ? 'ganada' : 'perdida';
    return { resultadoApuesta, resultadoReal };
}

function verifyHabraProrroga(partido, fixture) {
    const huboProrroga = fixture.score.extratime.home !== null;
    const resultadoReal = huboProrroga ? 'Sí hubo prórroga' : 'No hubo prórroga';
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if ((seleccion === 'sí' || seleccion === 'si') && huboProrroga) {
        resultadoApuesta = 'ganada';
    } else if (seleccion === 'no' && !huboProrroga) {
        resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyHabraPenaltis(partido, fixture) {
    const huboPenaltis = fixture.score.penalty.home !== null;
    const resultadoReal = huboPenaltis ? 'Sí hubo penaltis' : 'No hubo penaltis';
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if ((seleccion === 'sí' || seleccion === 'si') && huboPenaltis) {
        resultadoApuesta = 'ganada';
    } else if (seleccion === 'no' && !huboPenaltis) {
        resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyGolesExactos(partido, fixture) {
    const totalGoles = fixture.goals.home + fixture.goals.away;
    const resultadoReal = `Goles exactos: ${totalGoles}`;
    const seleccion = partido.seleccionado.toLowerCase();
    
    if (seleccion.includes('+')) {
        const valor = parseInt(seleccion.replace('+', ''));
        if (!isNaN(valor)) {
            const resultadoApuesta = totalGoles >= valor ? 'ganada' : 'perdida';
            return { resultadoApuesta, resultadoReal };
        }
    }

    const valorSeleccionado = parseInt(seleccion);
    if (isNaN(valorSeleccionado)) {
        return { resultadoApuesta: 'error_seleccion', resultadoReal };
    }

    const resultadoApuesta = totalGoles === valorSeleccionado ? 'ganada' : 'perdida';
    return { resultadoApuesta, resultadoReal };
}

function verifySeClasifica(partido, fixture) {
    const { teams, score } = fixture;
    let winnerName = null;

    if (score.penalty.home !== null && score.penalty.away !== null) {
        winnerName = score.penalty.home > score.penalty.away ? teams.home.name : teams.away.name;
    } else if (score.extratime.home !== null && score.extratime.away !== null) {
        winnerName = score.extratime.home > score.extratime.away ? teams.home.name : teams.away.name;
    } else if (teams.home.winner || teams.away.winner) {
        winnerName = teams.home.winner ? teams.home.name : teams.away.name;
    } else if (fixture.fixture.status.short === 'AET' || fixture.fixture.status.short === 'PEN') {
        // Fallback for weird API cases where winner flag is not set after ET/PEN
        const finalHome = (score.extratime.home ?? fixture.goals.home) + (score.penalty.home ?? 0);
        const finalAway = (score.extratime.away ?? fixture.goals.away) + (score.penalty.away ?? 0);
        if (finalHome !== finalAway) {
            winnerName = finalHome > finalAway ? teams.home.name : teams.away.name;
        }
    }

    if (!winnerName) {
        return { resultadoApuesta: 'error_no_ganador', resultadoReal: 'No se pudo determinar un ganador para la clasificación.' };
    }

    const resultadoReal = `Se clasifica: ${winnerName}`;
    const resultadoApuesta = partido.seleccionado.toLowerCase().includes(winnerName.toLowerCase()) ? 'ganada' : 'perdida';

    return { resultadoApuesta, resultadoReal };
}

function verifyHandicap1x2(partido, fixture) {
    const handicapRegex = /\((-?\d+(\.\d+)?)\)/;
    const match = partido.mercado.match(handicapRegex);

    if (!match) {
        return { resultadoApuesta: 'error_handicap_no_definido', resultadoReal: 'No se encontró el valor del hándicap en el mercado.' };
    }

    const handicapValue = parseFloat(match[1]);
    const adjustedHomeGoals = fixture.goals.home + handicapValue;
    const adjustedAwayGoals = fixture.goals.away;

    const resultadoReal = `Resultado con Hándicap (${handicapValue}): ${adjustedHomeGoals.toFixed(2)} - ${adjustedAwayGoals}`;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if (seleccion.includes(fixture.teams.home.name.toLowerCase()) || seleccion === '1') {
        if (adjustedHomeGoals > adjustedAwayGoals) resultadoApuesta = 'ganada';
    } else if (seleccion.includes('empate') || seleccion === 'x') {
        if (adjustedHomeGoals === adjustedAwayGoals) resultadoApuesta = 'ganada';
    } else if (seleccion.includes(fixture.teams.away.name.toLowerCase()) || seleccion === '2') {
        if (adjustedHomeGoals < adjustedAwayGoals) resultadoApuesta = 'ganada';
    }

    return { resultadoApuesta, resultadoReal };
}

function verifyQueEquipoMarca(partido, fixture) {
    const homeGoals = fixture.goals.home;
    const awayGoals = fixture.goals.away;
    const seleccion = partido.seleccionado.toLowerCase();

    let resultadoReal = '';
    if (homeGoals > 0 && awayGoals > 0) resultadoReal = 'Ambos equipos marcaron';
    else if (homeGoals > 0) resultadoReal = `Solo marcó ${fixture.teams.home.name}`;
    else if (awayGoals > 0) resultadoReal = `Solo marcó ${fixture.teams.away.name}`;
    else resultadoReal = 'Ningún equipo marcó';

    let resultadoApuesta = 'perdida';
    if (seleccion.includes('ambos') && homeGoals > 0 && awayGoals > 0) {
        resultadoApuesta = 'ganada';
    } else if (seleccion.includes(fixture.teams.home.name.toLowerCase()) && homeGoals > 0 && awayGoals === 0) {
        resultadoApuesta = 'ganada';
    } else if (seleccion.includes(fixture.teams.away.name.toLowerCase()) && awayGoals > 0 && homeGoals === 0) {
        resultadoApuesta = 'ganada';
    } else if (seleccion.includes('ninguno') && homeGoals === 0 && awayGoals === 0) {
        resultadoApuesta = 'ganada';
    }

    return { resultadoApuesta, resultadoReal };
}

function verifyMetodoDeClasificacion(partido, fixture) {
    const huboProrroga = fixture.score.extratime.home !== null;
    const huboPenaltis = fixture.score.penalty.home !== null;
    
    let metodoReal = 'Tiempo reglamentario';
    if (huboPenaltis) metodoReal = 'Penaltis';
    else if (huboProrroga) metodoReal = 'Prórroga';

    const resultadoReal = `Método de clasificación: ${metodoReal}`;
    const seleccion = partido.seleccionado.toLowerCase();
    const resultadoApuesta = seleccion.includes(metodoReal.toLowerCase()) ? 'ganada' : 'perdida';

    return { resultadoApuesta, resultadoReal };
}

function verifyMultigoles(partido, fixture) {
    const seleccion = partido.seleccionado.toLowerCase();
    const mercado = partido.mercado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let totalGoles;
    let resultadoRealPrefix;

    if (mercado.includes(homeTeamName)) {
        totalGoles = fixture.goals.home;
        resultadoRealPrefix = `Multigoles ${fixture.teams.home.name}`;
    } else if (mercado.includes(awayTeamName)) {
        totalGoles = fixture.goals.away;
        resultadoRealPrefix = `Multigoles ${fixture.teams.away.name}`;
    } else {
        totalGoles = fixture.goals.home + fixture.goals.away;
        resultadoRealPrefix = 'Multigoles';
    }

    const resultadoReal = `${resultadoRealPrefix}: ${totalGoles}`;

    const rangeMatch = seleccion.match(/(\d+)-(\d+)/);
    const orMoreMatch = seleccion.match(/(\d+)\s*o\s*m[aá]s/);

    let resultadoApuesta = 'perdida';

    if (rangeMatch) {
        const min = parseInt(rangeMatch[1]);
        const max = parseInt(rangeMatch[2]);
        if (totalGoles >= min && totalGoles <= max) {
            resultadoApuesta = 'ganada';
        }
    } else if (orMoreMatch) {
        const min = parseInt(orMoreMatch[1]);
        if (totalGoles >= min) {
            resultadoApuesta = 'ganada';
        }
    } else {
        return { resultadoApuesta: 'error_seleccion_invalida', resultadoReal };
    }

    return { resultadoApuesta, resultadoReal };
}

function verifyAmbosMarcanXGoles(partido, fixture) {
    const { home, away } = fixture.goals;
    const seleccion = partido.seleccionado.toLowerCase();
    const match = seleccion.match(/(\d+)\s*o\s*m[aá]s/);
    
    if (!match) {
        return { resultadoApuesta: 'error_seleccion_invalida', resultadoReal: `Resultado: ${home}-${away}` };
    }
    
    const requiredGoals = parseInt(match[1]);
    const resultadoReal = `Ambos marcan ${requiredGoals}+ goles? Local: ${home}, Visitante: ${away}`;
    
    let resultadoApuesta = 'perdida';
    if (home >= requiredGoals && away >= requiredGoals) {
        resultadoApuesta = 'ganada';
    }
    
    return { resultadoApuesta, resultadoReal };
}

function verifyAmbosMarcanAmbasMitades(partido, fixture) {
    const { halftime } = fixture.score;
    
    const firstHalfHomeGoals = halftime.home;
    const firstHalfAwayGoals = halftime.away;
    
    const totalHomeGoals = fixture.goals.home;
    const totalAwayGoals = fixture.goals.away;

    const secondHalfHomeGoals = totalHomeGoals - firstHalfHomeGoals;
    const secondHalfAwayGoals = totalAwayGoals - firstHalfAwayGoals;

    const resultadoReal = `1T: ${firstHalfHomeGoals}-${firstHalfAwayGoals}, 2T: ${secondHalfHomeGoals}-${secondHalfAwayGoals}`;

    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    const firstHalfBothScored = firstHalfHomeGoals > 0 && firstHalfAwayGoals > 0;
    const secondHalfBothScored = secondHalfHomeGoals > 0 && secondHalfAwayGoals > 0;

    if (seleccion === 'sí' || seleccion === 'si') {
        if (firstHalfBothScored && secondHalfBothScored) {
            resultadoApuesta = 'ganada';
        }
    } else if (seleccion === 'no') {
        if (!firstHalfBothScored || !secondHalfBothScored) {
            resultadoApuesta = 'ganada';
        }
    }

    return { resultadoApuesta, resultadoReal };
}

// --- Mercados de Primera Mitad ---

function verifyPrimeraMitad1x2(partido, fixture) {
    const { home, away } = fixture.score.halftime;
    const resultadoReal = `1T: ${home}-${away}`;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if ((seleccion.includes(fixture.teams.home.name.toLowerCase()) || seleccion === '1') && home > away) {
        resultadoApuesta = 'ganada';
    } else if ((seleccion.includes('empate') || seleccion === 'x') && home === away) {
        resultadoApuesta = 'ganada';
    } else if ((seleccion.includes(fixture.teams.away.name.toLowerCase()) || seleccion === '2') && home < away) {
        resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyPrimeraMitadDobleOportunidad(partido, fixture) {
    const { home, away } = fixture.score.halftime;
    const resultadoReal = `1T: ${home}-${away}`;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if (seleccion.includes('1x') || seleccion.includes('local o empate')) {
        if (home >= away) resultadoApuesta = 'ganada';
    } else if (seleccion.includes('12') || seleccion.includes('local o visitante')) {
        if (home !== away) resultadoApuesta = 'ganada';
    } else if (seleccion.includes('x2') || seleccion.includes('empate o visitante')) {
        if (home <= away) resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyPrimeraMitadTotalDeGoles(partido, fixture) {
    const { home, away } = fixture.score.halftime;
    const totalGoles = home + away;
    const resultadoReal = `1T Goles: ${totalGoles}`;
    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : 'menos';
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (totalGoles > valor) resultadoApuesta = 'ganada';
    } else {
        if (totalGoles < valor) resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyPrimeraMitadEquipoTotalDeGoles(partido, fixture) {
    const mercado = partido.mercado.toLowerCase();
    const { home, away } = fixture.score.halftime;
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let teamGoals, teamName;
    if (mercado.includes(homeTeamName)) {
        teamGoals = home;
        teamName = fixture.teams.home.name;
    } else if (mercado.includes(awayTeamName)) {
        teamGoals = away;
        teamName = fixture.teams.away.name;
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'No se pudo identificar el equipo en el mercado.' };
    }

    const resultadoReal = `1T Goles ${teamName}: ${teamGoals}`;
    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : 'menos';
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (teamGoals > valor) resultadoApuesta = 'ganada';
    } else {
        if (teamGoals < valor) resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyPrimeraMitadAmbosMarcan(partido, fixture) {
    const { home, away } = fixture.score.halftime;
    const resultadoReal = `1T: ${home}-${away}`;
    const seleccion = partido.seleccionado.toLowerCase();
    const ambosMarcaron = home > 0 && away > 0;

    let resultadoApuesta = 'perdida';
    if ((seleccion === 'sí' || seleccion === 'si') && ambosMarcaron) {
        resultadoApuesta = 'ganada';
    } else if (seleccion === 'no' && !ambosMarcaron) {
        resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

// --- Mercados de Jugadores ---

// Helper para encontrar a un jugador y sus estadísticas
function findPlayerData(seleccionado, fixture) {
    if (!fixture.players || fixture.players.length === 0) return null;
    const playerName = seleccionado.split('-')[0].trim().toLowerCase();
    for (const team of fixture.players) {
        const playerData = team.players.find(p => p.player.name.toLowerCase().includes(playerName));
        if (playerData && playerData.statistics) {
            return playerData;
        }
    }
    return null;
}

function verifyGoleador(partido, fixture) {
    const playerData = findPlayerData(partido.seleccionado, fixture);
    if (!playerData) {
        return { resultadoApuesta: 'error_jugador_no_encontrado', resultadoReal: 'Jugador no encontrado o sin estadísticas.' };
    }

    const goals = playerData.statistics[0].goals.total || 0;
    const resultadoReal = `${playerData.player.name} marcó ${goals} gol(es).`;
    const resultadoApuesta = goals > 0 ? 'ganada' : 'perdida';
    
    return { resultadoApuesta, resultadoReal };
}

function verifyMultigoleador(partido, fixture) {
    const seleccion = partido.seleccionado.toLowerCase();
    const match = seleccion.match(/(\d+)\s*o\s*m[aá]s/);
    if (!match) {
        return { resultadoApuesta: 'error_seleccion_invalida', resultadoReal: 'Selección de multigoleador no válida.' };
    }
    const requiredGoals = parseInt(match[1]);

    const playerData = findPlayerData(partido.seleccionado, fixture);
    if (!playerData) {
        return { resultadoApuesta: 'error_jugador_no_encontrado', resultadoReal: 'Jugador no encontrado o sin estadísticas.' };
    }

    const goals = playerData.statistics[0].goals.total || 0;
    const resultadoReal = `${playerData.player.name} marcó ${goals} gol(es).`;
    const resultadoApuesta = goals >= requiredGoals ? 'ganada' : 'perdida';
    
    return { resultadoApuesta, resultadoReal };
}

function verifyAsistencia(partido, fixture) {
    const playerData = findPlayerData(partido.seleccionado, fixture);
    if (!playerData) {
        return { resultadoApuesta: 'error_jugador_no_encontrado', resultadoReal: 'Jugador no encontrado o sin estadísticas.' };
    }

    const assists = playerData.statistics[0].goals.assists || 0;
    const resultadoReal = `${playerData.player.name} hizo ${assists} asistencia(s).`;
    const resultadoApuesta = assists > 0 ? 'ganada' : 'perdida';
    
    return { resultadoApuesta, resultadoReal };
}

function verifyPlayerShots(partido, fixture, shotType) {
    const playerData = findPlayerData(partido.seleccionado, fixture);
    if (!playerData) {
        return { resultadoApuesta: 'error_jugador_no_encontrado', resultadoReal: 'Jugador no encontrado o sin estadísticas.' };
    }

    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes.find(p => p === 'más' || p === 'mas') ? 'más' : 'menos';
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));
    
    if (isNaN(valor)) {
        return { resultadoApuesta: 'error_seleccion_invalida', resultadoReal: 'Valor de remates no válido.' };
    }

    const shots = shotType === 'on' ? (playerData.statistics[0].shots.on || 0) : (playerData.statistics[0].shots.total || 0);
    const shotTypeName = shotType === 'on' ? 'a puerta' : 'totales';
    const resultadoReal = `${playerData.player.name} - Remates ${shotTypeName}: ${shots}`;

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (shots > valor) resultadoApuesta = 'ganada';
    } else {
        if (shots < valor) resultadoApuesta = 'ganada';
    }

    return { resultadoApuesta, resultadoReal };
}

function verifyPlayerCard(partido, fixture) {
    const playerData = findPlayerData(partido.seleccionado, fixture);
    if (!playerData) {
        return { resultadoApuesta: 'error_jugador_no_encontrado', resultadoReal: 'Jugador no encontrado o sin estadísticas.' };
    }

    const yellowCards = playerData.statistics[0].cards.yellow || 0;
    const redCards = playerData.statistics[0].cards.red || 0;
    const receivedCard = yellowCards > 0 || redCards > 0;
    
    const resultadoReal = `${playerData.player.name} - Tarjetas: ${yellowCards} Amarilla(s), ${redCards} Roja(s).`;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if ((seleccion.includes('sí') || seleccion.includes('si')) && receivedCard) {
        resultadoApuesta = 'ganada';
    } else if (seleccion.includes('no') && !receivedCard) {
        resultadoApuesta = 'ganada';
    }

    return { resultadoApuesta, resultadoReal };
}

// --- Mercados de Córners (Partido Completo) ---

function getCornersForTeam(teamStats) {
    if (!teamStats || !teamStats.statistics) return 0;
    const cornerStat = teamStats.statistics.find(s => s.type === 'Corner Kicks');
    return cornerStat ? (cornerStat.value || 0) : 0;
}

function verifyTotalCornersPorEquipo(partido, fixture) {
    const mercado = partido.mercado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let teamCorners, teamName;
    if (mercado.includes(homeTeamName)) {
        teamCorners = getCornersForTeam(fixture.statistics[0]);
        teamName = fixture.teams.home.name;
    } else if (mercado.includes(awayTeamName)) {
        teamCorners = getCornersForTeam(fixture.statistics[1]);
        teamName = fixture.teams.away.name;
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'No se pudo identificar el equipo en el mercado.' };
    }

    const resultadoReal = `Córners de ${teamName}: ${teamCorners}`;
    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : 'menos';
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (teamCorners > valor) resultadoApuesta = 'ganada';
    } else {
        if (teamCorners < valor) resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyHandicapCorner(partido, fixture) {
    const handicapRegex = /\((-?\d+(\.\d+)?)\)/;
    const match = partido.mercado.match(handicapRegex);
    if (!match) {
        return { resultadoApuesta: 'error_handicap_no_definido', resultadoReal: 'No se encontró el valor del hándicap en el mercado.' };
    }

    const handicapValue = parseFloat(match[1]);
    const homeCorners = getCornersForTeam(fixture.statistics[0]);
    const awayCorners = getCornersForTeam(fixture.statistics[1]);

    const adjustedHomeCorners = homeCorners + handicapValue;
    const resultadoReal = `Resultado Córners con Hándicap (${handicapValue}): ${adjustedHomeCorners.toFixed(2)} - ${awayCorners}`;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if (seleccion.includes(fixture.teams.home.name.toLowerCase()) || seleccion === '1') {
        if (adjustedHomeCorners > awayCorners) resultadoApuesta = 'ganada';
    } else if (seleccion.includes(fixture.teams.away.name.toLowerCase()) || seleccion === '2') {
        if (adjustedHomeCorners < awayCorners) resultadoApuesta = 'ganada';
    }

    return { resultadoApuesta, resultadoReal };
}

function verifyPrimerOultimoCorner(partido, fixture, tipo) {
    const cornerEvents = fixture.events.filter(e => e.type === 'Corner').sort((a, b) => a.time.elapsed - b.time.elapsed);
    if (cornerEvents.length === 0) {
        return { resultadoApuesta: 'anulada', resultadoReal: 'No hubo córners.' };
    }

    const corner = tipo === 'primer' ? cornerEvents[0] : cornerEvents[cornerEvents.length - 1];
    const teamName = corner.team.name;
    const resultadoReal = `${tipo === 'primer' ? 'Primer' : 'Último'} córner: ${teamName} (${corner.time.elapsed}')`;
    const resultadoApuesta = teamName.toLowerCase().includes(partido.seleccionado.toLowerCase()) ? 'ganada' : 'perdida';

    return { resultadoApuesta, resultadoReal };
}

function verifyCornersParImpar(partido, fixture) {
    const homeCorners = getCornersForTeam(fixture.statistics[0]);
    const awayCorners = getCornersForTeam(fixture.statistics[1]);
    const totalCorners = homeCorners + awayCorners;
    const resultadoReal = `Total Córners: ${totalCorners}`;
    const esPar = totalCorners % 2 === 0;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if (seleccion === 'par' && esPar) {
        resultadoApuesta = 'ganada';
    } else if (seleccion === 'impar' && !esPar) {
        resultadoApuesta = 'ganada';
    }

    return { resultadoApuesta, resultadoReal };
}

// --- Mercados de Córners y Goles (Primera Mitad) ---

function getFirstHalfData(fixture) {
    const homeTeamId = fixture.teams.home.id;
    const firstHalfEvents = fixture.events.filter(e => e.time.elapsed <= 45);

    let homeCorners = 0, awayCorners = 0;
    const cornerEvents = [];

    for (const event of firstHalfEvents) {
        if (event.type === 'Corner') {
            cornerEvents.push(event);
            if (event.team.id === homeTeamId) homeCorners++;
            else awayCorners++;
        }
    }
    return { homeCorners, awayCorners, cornerEvents };
}

function verifyPrimeraMitadTotalCorners(partido, fixture) {
    const { homeCorners, awayCorners } = getFirstHalfData(fixture);
    const totalCorners = homeCorners + awayCorners;
    const resultadoReal = `1T Córners: ${totalCorners}`;
    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : 'menos';
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (totalCorners > valor) resultadoApuesta = 'ganada';
    } else {
        if (totalCorners < valor) resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyPrimeraMitadTotalCornersPorEquipo(partido, fixture) {
    const { homeCorners, awayCorners } = getFirstHalfData(fixture);
    const mercado = partido.mercado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let teamCorners, teamName;
    if (mercado.includes(homeTeamName)) {
        teamCorners = homeCorners;
        teamName = fixture.teams.home.name;
    } else if (mercado.includes(awayTeamName)) {
        teamCorners = awayCorners;
        teamName = fixture.teams.away.name;
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'No se pudo identificar el equipo.' };
    }

    const resultadoReal = `1T Córners ${teamName}: ${teamCorners}`;
    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : 'menos';
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (teamCorners > valor) resultadoApuesta = 'ganada';
    } else {
        if (teamCorners < valor) resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyPrimeraMitadUltimoCorner(partido, fixture) {
    const { cornerEvents } = getFirstHalfData(fixture);
    if (cornerEvents.length === 0) {
        return { resultadoApuesta: 'anulada', resultadoReal: 'No hubo córners en la 1T.' };
    }

    const ultimoCorner = cornerEvents.sort((a, b) => b.time.elapsed - a.time.elapsed)[0];
    const teamName = ultimoCorner.team.name;
    const resultadoReal = `Último córner 1T: ${teamName} (${ultimoCorner.time.elapsed}')`;
    const resultadoApuesta = teamName.toLowerCase().includes(partido.seleccionado.toLowerCase()) ? 'ganada' : 'perdida';
    return { resultadoApuesta, resultadoReal };
}

function verifyPrimeraMitadCornersParImpar(partido, fixture) {
    const { homeCorners, awayCorners } = getFirstHalfData(fixture);
    const totalCorners = homeCorners + awayCorners;
    const resultadoReal = `1T Total Córners: ${totalCorners}`;
    const esPar = totalCorners % 2 === 0;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if (seleccion === 'par' && esPar) {
        resultadoApuesta = 'ganada';
    } else if (seleccion === 'impar' && !esPar) {
        resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyPrimeraMitadGolesParImpar(partido, fixture) {
    const { home, away } = fixture.score.halftime;
    const totalGoles = home + away;
    const resultadoReal = `1T Goles: ${totalGoles}`;
    const esPar = totalGoles % 2 === 0;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if (seleccion === 'par' && esPar) {
        resultadoApuesta = 'ganada';
    } else if (seleccion === 'impar' && !esPar) {
        resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

// --- Mercados de Tarjetas ---

function getCardsForTeam(teamStats) {
    if (!teamStats || !teamStats.statistics) return 0;
    const yellowCardStat = teamStats.statistics.find(s => s.type === 'Yellow Cards');
    const redCardStat = teamStats.statistics.find(s => s.type === 'Red Cards');
    const yellowCards = yellowCardStat ? (yellowCardStat.value || 0) : 0;
    const redCards = redCardStat ? (redCardStat.value || 0) : 0;
    return yellowCards + redCards;
}

function verifyTotalTarjetas(partido, fixture) {
    const homeCards = getCardsForTeam(fixture.statistics[0]);
    const awayCards = getCardsForTeam(fixture.statistics[1]);
    const totalCards = homeCards + awayCards;

    const resultadoReal = `Total Tarjetas: ${totalCards}`;
    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : 'menos';
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (totalCards > valor) resultadoApuesta = 'ganada';
    } else {
        if (totalCards < valor) resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyTarjetas1x2(partido, fixture) {
    const homeCards = getCardsForTeam(fixture.statistics[0]);
    const awayCards = getCardsForTeam(fixture.statistics[1]);
    const resultadoReal = `Tarjetas: Local ${homeCards} - Visitante ${awayCards}`;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if ((seleccion.includes(fixture.teams.home.name.toLowerCase()) || seleccion === '1') && homeCards > awayCards) {
        resultadoApuesta = 'ganada';
    } else if ((seleccion.includes('empate') || seleccion.includes('x')) && homeCards === awayCards) {
        resultadoApuesta = 'ganada';
    } else if ((seleccion.includes(fixture.teams.away.name.toLowerCase()) || seleccion === '2') && homeCards < awayCards) {
        resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

// --- Mercados de Primera y Segunda Mitad (Goles) ---

function getSecondHalfGoals(fixture) {
    const halftime = fixture.score.halftime;
    const fulltime = fixture.score.fulltime;
    const home = (fulltime.home || 0) - (halftime.home || 0);
    const away = (fulltime.away || 0) - (halftime.away || 0);
    return { home, away };
}

function verifyPrimeraMitadMarcadorExacto(partido, fixture) {
    const { home, away } = fixture.score.halftime;
    const resultadoReal = `1T Marcador: ${home} - ${away}`;
    const seleccion = partido.seleccionado.replace(/\s/g, '');
    const resultadoApuesta = seleccion === `${home}-${away}` ? 'ganada' : 'perdida';
    return { resultadoApuesta, resultadoReal };
}

function verifySegundaMitadTotalGoles(partido, fixture) {
    const { home, away } = getSecondHalfGoals(fixture);
    const totalGoles = home + away;
    const resultadoReal = `2T Goles: ${totalGoles}`;
    
    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : 'menos';
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (totalGoles > valor) resultadoApuesta = 'ganada';
    } else { 
        if (totalGoles < valor) resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifySegundaMitadTotalGolesPorEquipo(partido, fixture) {
    const { home, away } = getSecondHalfGoals(fixture);
    const mercado = partido.mercado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let teamGoals, teamName;
    if (mercado.includes(homeTeamName)) {
        teamGoals = home;
        teamName = fixture.teams.home.name;
    } else if (mercado.includes(awayTeamName)) {
        teamGoals = away;
        teamName = fixture.teams.away.name;
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'No se pudo identificar el equipo.' };
    }

    const resultadoReal = `2T Goles ${teamName}: ${teamGoals}`;
    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : 'menos';
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (teamGoals > valor) resultadoApuesta = 'ganada';
    } else { 
        if (teamGoals < valor) resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifySegundaMitadAmbosMarcan(partido, fixture) {
    const { home, away } = getSecondHalfGoals(fixture);
    const resultadoReal = `2T Goles: Local ${home} - Visitante ${away}`;
    const ambosMarcan = home > 0 && away > 0;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if ((seleccion === 'sí' || seleccion === 'si') && ambosMarcan) {
        resultadoApuesta = 'ganada';
    } else if (seleccion === 'no' && !ambosMarcan) {
        resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifySegundaMitadEquipoMarca(partido, fixture) {
    const { home, away } = getSecondHalfGoals(fixture);
    const mercado = partido.mercado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let teamGoals, teamName;
    if (mercado.includes(homeTeamName)) {
        teamGoals = home;
        teamName = fixture.teams.home.name;
    } else if (mercado.includes(awayTeamName)) {
        teamGoals = away;
        teamName = fixture.teams.away.name;
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'No se pudo identificar el equipo.' };
    }
    
    const equipoMarco = teamGoals > 0;
    const resultadoReal = `2T ${teamName} marcó: ${equipoMarco ? 'Sí' : 'No'}`;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if ((seleccion === 'sí' || seleccion === 'si') && equipoMarco) {
        resultadoApuesta = 'ganada';
    } else if (seleccion === 'no' && !equipoMarco) {
        resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

// --- Mercados de Tarjetas por Equipo y Rendimiento por Mitades ---

function verifyTotalTarjetasPorEquipo(partido, fixture) {
    const mercado = partido.mercado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let teamCards, teamName;
    if (mercado.includes(homeTeamName)) {
        teamCards = getCardsForTeam(fixture.statistics[0]);
        teamName = fixture.teams.home.name;
    } else if (mercado.includes(awayTeamName)) {
        teamCards = getCardsForTeam(fixture.statistics[1]);
        teamName = fixture.teams.away.name;
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'No se pudo identificar el equipo.' };
    }

    const resultadoReal = `Tarjetas de ${teamName}: ${teamCards}`;
    const seleccion = partido.seleccionado.toLowerCase();
    const partes = seleccion.split(' ');
    const tipo = partes[0].includes('más') ? 'más' : 'menos';
    const valor = parseFloat(partes[partes.length - 1].replace(',', '.'));

    let resultadoApuesta = 'perdida';
    if (tipo === 'más') {
        if (teamCards > valor) resultadoApuesta = 'ganada';
    } else {
        if (teamCards < valor) resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}

function verifyEquipoGanaAmbasMitades(partido, fixture) {
    const firstHalf = fixture.score.halftime;
    const secondHalf = getSecondHalfGoals(fixture);
    const teamName = partido.seleccionado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let ganoPrimera, ganoSegunda;
    if (teamName.includes(homeTeamName)) {
        ganoPrimera = firstHalf.home > firstHalf.away;
        ganoSegunda = secondHalf.home > secondHalf.away;
    } else if (teamName.includes(awayTeamName)) {
        ganoPrimera = firstHalf.away > firstHalf.home;
        ganoSegunda = secondHalf.away > secondHalf.home;
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'Equipo no identificado.' };
    }

    const resultadoReal = `1T: ${firstHalf.home}-${firstHalf.away}, 2T: ${secondHalf.home}-${secondHalf.away}`;
    const resultadoApuesta = ganoPrimera && ganoSegunda ? 'ganada' : 'perdida';
    return { resultadoApuesta, resultadoReal };
}

function verifyEquipoGanaCualquierMitad(partido, fixture) {
    const firstHalf = fixture.score.halftime;
    const secondHalf = getSecondHalfGoals(fixture);
    const teamName = partido.seleccionado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let ganoPrimera, ganoSegunda;
    if (teamName.includes(homeTeamName)) {
        ganoPrimera = firstHalf.home > firstHalf.away;
        ganoSegunda = secondHalf.home > secondHalf.away;
    } else if (teamName.includes(awayTeamName)) {
        ganoPrimera = firstHalf.away > firstHalf.home;
        ganoSegunda = secondHalf.away > secondHalf.home;
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'Equipo no identificado.' };
    }

    const resultadoReal = `1T: ${firstHalf.home}-${firstHalf.away}, 2T: ${secondHalf.home}-${secondHalf.away}`;
    const resultadoApuesta = ganoPrimera || ganoSegunda ? 'ganada' : 'perdida';
    return { resultadoApuesta, resultadoReal };
}

function verifyEquipoMarcaEnAmbasPartes(partido, fixture) {
    const firstHalf = fixture.score.halftime;
    const secondHalf = getSecondHalfGoals(fixture);
    const teamName = partido.seleccionado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let marcoEnPrimera, marcoEnSegunda;
    if (teamName.includes(homeTeamName)) {
        marcoEnPrimera = firstHalf.home > 0;
        marcoEnSegunda = secondHalf.home > 0;
    } else if (teamName.includes(awayTeamName)) {
        marcoEnPrimera = firstHalf.away > 0;
        marcoEnSegunda = secondHalf.away > 0;
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'Equipo no identificado.' };
    }

    const resultadoReal = `Goles 1T: ${firstHalf.home}-${firstHalf.away}, Goles 2T: ${secondHalf.home}-${secondHalf.away}`;
    const resultadoApuesta = marcoEnPrimera && marcoEnSegunda ? 'ganada' : 'perdida';
    return { resultadoApuesta, resultadoReal };
}

// --- Mercados Finales (Remontada, Córner 1x2) ---

function verifyEquipoRemonta(partido, fixture) {
    const halftime = fixture.score.halftime;
    const fulltime = fixture.score.fulltime;
    const teamName = partido.seleccionado.toLowerCase();
    const homeTeamName = fixture.teams.home.name.toLowerCase();
    const awayTeamName = fixture.teams.away.name.toLowerCase();

    let remonto = false;
    if (teamName.includes(homeTeamName)) {
        // Perdía al descanso y ganó al final
        if (halftime.home < halftime.away && fulltime.home > fulltime.away) {
            remonto = true;
        }
    } else if (teamName.includes(awayTeamName)) {
        // Perdía al descanso y ganó al final
        if (halftime.away < halftime.home && fulltime.away > fulltime.home) {
            remonto = true;
        }
    } else {
        return { resultadoApuesta: 'error_equipo_no_encontrado', resultadoReal: 'Equipo no identificado.' };
    }

    const resultadoReal = `Resultado 1T: ${halftime.home}-${halftime.away}, Final: ${fulltime.home}-${fulltime.away}`;
    const resultadoApuesta = remonto ? 'ganada' : 'perdida';
    return { resultadoApuesta, resultadoReal };
}

function verifyCorner1x2(partido, fixture) {
    const homeCorners = getCornersForTeam(fixture.statistics[0]);
    const awayCorners = getCornersForTeam(fixture.statistics[1]);
    const resultadoReal = `Córners: Local ${homeCorners} - Visitante ${awayCorners}`;
    const seleccion = partido.seleccionado.toLowerCase();
    let resultadoApuesta = 'perdida';

    if ((seleccion.includes(fixture.teams.home.name.toLowerCase()) || seleccion === '1') && homeCorners > awayCorners) {
        resultadoApuesta = 'ganada';
    } else if ((seleccion.includes('empate') || seleccion.includes('x')) && homeCorners === awayCorners) {
        resultadoApuesta = 'ganada';
    } else if ((seleccion.includes(fixture.teams.away.name.toLowerCase()) || seleccion === '2') && homeCorners < awayCorners) {
        resultadoApuesta = 'ganada';
    }
    return { resultadoApuesta, resultadoReal };
}


// =================================================================
// FUNCIÓN AUXILIAR PARA VERIFICAR UN ÚNICO PARTIDO
// =================================================================
async function verifySingleMatch(partido, apiKey, fixtureCache) {
    try {
        // 1. Parsear datos del partido
        const equipos = partido.partido.split(/\s+vs\.?\s+/i);
        if (equipos.length < 2) {
            return {
                partido_id: partido.id,
                partido_verificado: partido.partido,
                resultado_apuesta: 'error',
                detalle: `El nombre del partido no tiene el formato esperado 'Equipo A vs Equipo B'.`
            };
        }
        const [equipoLocal, equipoVisitante] = equipos;

        const fechaCompleta = partido.fecha_hora;
        const fechaSinHora = fechaCompleta.split(' ')[0];
        const [day, month, yearPart] = fechaSinHora.split('/');
        const fullYear = yearPart.length === 2 ? `20${yearPart}` : yearPart;
        const fechaISO = `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

        // 2. Obtener datos del partido (desde caché o API)
        let fixturesDelDia = fixtureCache[fechaISO];
        if (!fixturesDelDia) {
            console.log(`Cache miss. Buscando en API para la fecha: ${fechaISO}`);
            const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
                params: { date: fechaISO },
                headers: { 'x-apisports-key': apiKey }
            });
            
            if (response.data.errors && Object.keys(response.data.errors).length > 0) {
                 throw new Error(`Error de la API: ${JSON.stringify(response.data.errors)}`);
            }

            fixturesDelDia = response.data.response;
            fixtureCache[fechaISO] = fixturesDelDia;
        } else {
            console.log(`Cache hit. Usando datos guardados para la fecha: ${fechaISO}`);
        }

        // 3. Encontrar el partido específico
        const fixture = fixturesDelDia.find(f => {
            const apiHome = f.teams?.home?.name?.toLowerCase();
            const apiAway = f.teams?.away?.name?.toLowerCase();
            const ticketHome = equipoLocal.toLowerCase();
            const ticketAway = equipoVisitante.toLowerCase();
            if (!apiHome || !apiAway) return false;
            return (apiHome.includes(ticketHome) && apiAway.includes(ticketAway)) ||
                   (apiHome.includes(ticketAway) && apiAway.includes(ticketHome));
        });

        if (!fixture) {
            const errorDetail = `No se encontró el partido en la API. Búsqueda: [${equipoLocal} vs ${equipoVisitante}] en fecha [${fechaISO}]`;
            console.warn(`ADVERTENCIA: ${errorDetail}`);
            return {
                partido_id: partido.id,
                partido_verificado: partido.partido,
                resultado_apuesta: 'error_partido_no_encontrado',
                detalle: errorDetail
            };
        }

        // 4. Determinar el resultado de la apuesta
        let resultadoApuesta = 'pendiente';
        let resultadoReal = 'El partido no ha finalizado.';

        if (fixture.fixture.status.short !== 'FT') {
            resultadoApuesta = `pendiente_${fixture.fixture.status.short}`;
            resultadoReal = `Estado actual: ${fixture.fixture.status.long}`;
        } else {
            // Usamos un objeto para almacenar los resultados de la verificación del mercado
            let verificacionMercado;
            const mercadoOriginal = partido.mercado.toLowerCase();
            const mercadoNormalizado = mercadoOriginal.replace(/\s+/g, '');

            // Usamos switch(true) para manejar casos complejos y por orden de prioridad
            switch (true) {
                case mercadoNormalizado.includes('resultadodelpartido'):
                case mercadoNormalizado.includes('1x2'):
                    verificacionMercado = verifyResultadoDelPartido(partido, fixture);
                    break;
                // Este caso debe comprobarse ANTES que 'totaldegoles' general
                case mercadoOriginal.includes('total de goles') && (mercadoOriginal.includes(fixture.teams.home.name.toLowerCase()) || mercadoOriginal.includes(fixture.teams.away.name.toLowerCase())):
                    verificacionMercado = verifyEquipoTotalDeGoles(partido, fixture);
                    break;
                case mercadoNormalizado.includes('totaldegoles'):
                    verificacionMercado = verifyTotalDeGoles(partido, fixture);
                    break;
                case mercadoNormalizado.includes('golesexactos'):
                    verificacionMercado = verifyGolesExactos(partido, fixture);
                    break;
                case mercadoNormalizado.includes('dobleoportunidad'):
                    verificacionMercado = verifyDobleOportunidad(partido, fixture);
                    break;
                case mercadoNormalizado.includes('ambosequiposmarcan'):
                    verificacionMercado = verifyAmbosEquiposMarcan(partido, fixture);
                    break;
                case mercadoNormalizado.includes('resultadoaldescanso'):
                    verificacionMercado = verifyResultadoAlDescanso(partido, fixture);
                    break;
                case mercadoNormalizado.includes('totaldecórners'):
                case mercadoNormalizado.includes('totaldecorners'):
                    verificacionMercado = verifyTotalDeCorners(partido, fixture);
                    break;
                case mercadoNormalizado.includes('apuestasinempate'):
                    verificacionMercado = verifyApuestaSinEmpate(partido, fixture);
                    break;
                case mercadoNormalizado.includes('marcadorexacto'):
                    verificacionMercado = verifyMarcadorExacto(partido, fixture);
                    break;
                case mercadoNormalizado.includes('mitad/final'):
                    verificacionMercado = verifyMitadFinal(partido, fixture);
                    break;
                case mercadoNormalizado.includes('primergol'):
                    verificacionMercado = verifyPrimerOultimoGol(partido, fixture, 'primer');
                    break;
                case mercadoNormalizado.includes('últimogol'):
                case mercadoNormalizado.includes('ultimogol'):
                    verificacionMercado = verifyPrimerOultimoGol(partido, fixture, 'ultimo');
                    break;
                case mercadoNormalizado.includes('margendevictoria'):
                    verificacionMercado = verifyMargenDeVictoria(partido, fixture);
                    break;
                case mercadoNormalizado.includes('habráprórroga'):
                case mercadoNormalizado.includes('habraprorroga'):
                    verificacionMercado = verifyHabraProrroga(partido, fixture);
                    break;
                case mercadoNormalizado.includes('habrálanzamientosdepenaltis'):
                case mercadoNormalizado.includes('habrapenaltis'):
                    verificacionMercado = verifyHabraPenaltis(partido, fixture);
                    break;
                case mercadoNormalizado.includes('seclasifica'):
                    verificacionMercado = verifySeClasifica(partido, fixture);
                    break;
                case mercadoNormalizado.includes('hándicap1x2'):
                case mercadoNormalizado.includes('handicap1x2'):
                    verificacionMercado = verifyHandicap1x2(partido, fixture);
                    break;
                case mercadoNormalizado.includes('queequipomarca'):
                    verificacionMercado = verifyQueEquipoMarca(partido, fixture);
                    break;
                case mercadoNormalizado.includes('métododeclasificación'):
                case mercadoNormalizado.includes('metododeclasificacion'):
                    verificacionMercado = verifyMetodoDeClasificacion(partido, fixture);
                    break;
                // Este caso debe ir antes de 'ambosequiposmarcan' general
                case mercadoNormalizado.includes('ambosequiposmarcanenambasmitades'):
                    verificacionMercado = verifyAmbosMarcanAmbasMitades(partido, fixture);
                    break;
                // Este caso debe ir antes de 'ambosequiposmarcan' general
                case mercadoNormalizado.includes('ambosequiposmarcan') && mercadoNormalizado.includes('golesomás'):
                    verificacionMercado = verifyAmbosMarcanXGoles(partido, fixture);
                    break;
                // Este caso debe ir antes de 'totaldegoles' y otros más genéricos
                case mercadoNormalizado.includes('multigoles'):
                    verificacionMercado = verifyMultigoles(partido, fixture);
                    break;
                // --- Mercados de 1a Mitad ---
                case mercadoNormalizado.includes('1amitad-') && mercadoNormalizado.includes('totaldegoles') && (mercadoOriginal.includes(fixture.teams.home.name.toLowerCase()) || mercadoOriginal.includes(fixture.teams.away.name.toLowerCase())):
                    verificacionMercado = verifyPrimeraMitadEquipoTotalDeGoles(partido, fixture);
                    break;
                case mercadoNormalizado.includes('1amitad-totaldegoles'):
                    verificacionMercado = verifyPrimeraMitadTotalDeGoles(partido, fixture);
                    break;
                case mercadoNormalizado.includes('1amitad-dobleoportunidad'):
                    verificacionMercado = verifyPrimeraMitadDobleOportunidad(partido, fixture);
                    break;
                case mercadoNormalizado.includes('1amitad-ambosequiposmarcan'):
                    verificacionMercado = verifyPrimeraMitadAmbosMarcan(partido, fixture);
                    break;
                case mercadoNormalizado.includes('1amitad-1x2'):
                    verificacionMercado = verifyPrimeraMitad1x2(partido, fixture);
                    break;
                case mercadoNormalizado.includes('1amitad-par/impar'): // Asumiendo que es para goles
                    verificacionMercado = verifyPrimeraMitadGolesParImpar(partido, fixture);
                    break;
                // --- Mercados de Córners 1a Mitad ---
                case mercadoNormalizado.includes('1amitad-totalcórneres') && (mercadoOriginal.includes(fixture.teams.home.name.toLowerCase()) || mercadoOriginal.includes(fixture.teams.away.name.toLowerCase())):
                    verificacionMercado = verifyPrimeraMitadTotalCornersPorEquipo(partido, fixture);
                    break;
                case mercadoNormalizado.includes('1amitad-totalcórneres'):
                    verificacionMercado = verifyPrimeraMitadTotalCorners(partido, fixture);
                    break;
                case mercadoNormalizado.includes('1amitad-últimocórner'):
                case mercadoNormalizado.includes('1amitad-ultimocorner'):
                    verificacionMercado = verifyPrimeraMitadUltimoCorner(partido, fixture);
                    break;
                case mercadoNormalizado.includes('1amitad-córnerespar/impar'):
                    verificacionMercado = verifyPrimeraMitadCornersParImpar(partido, fixture);
                    break;
                case mercadoNormalizado.includes('1amitad-marcadorexacto'):
                    verificacionMercado = verifyPrimeraMitadMarcadorExacto(partido, fixture);
                    break;

                // --- Mercados 2a Mitad ---
                case mercadoNormalizado.includes('2mitad-totaldegoles') && (mercadoOriginal.includes(fixture.teams.home.name.toLowerCase()) || mercadoOriginal.includes(fixture.teams.away.name.toLowerCase())):
                    verificacionMercado = verifySegundaMitadTotalGolesPorEquipo(partido, fixture);
                    break;
                case mercadoNormalizado.includes('2mitad-totaldegoles'):
                    verificacionMercado = verifySegundaMitadTotalGoles(partido, fixture);
                    break;
                case mercadoNormalizado.includes('2mitad-ambosequiposmarcan'):
                    verificacionMercado = verifySegundaMitadAmbosMarcan(partido, fixture);
                    break;
                case mercadoNormalizado.includes('2mitad-') && mercadoNormalizado.includes('paramarcar'):
                    verificacionMercado = verifySegundaMitadEquipoMarca(partido, fixture);
                    break;
                // --- Mercados de Jugadores (deben ser específicos para no colisionar) ---
                case mercadoNormalizado.includes('rematesapuerta'):
                     verificacionMercado = verifyPlayerShots(partido, fixture, 'on');
                     break;
                case mercadoNormalizado.includes('remates'):
                     verificacionMercado = verifyPlayerShots(partido, fixture, 'total');
                     break;
                case mercadoNormalizado.includes('multigoleadores'): // antes de 'goleador'
                    verificacionMercado = verifyMultigoleador(partido, fixture);
                    break;
                case mercadoNormalizado.includes('goleador'):
                    verificacionMercado = verifyGoleador(partido, fixture);
                    break;
                case mercadoNormalizado.includes('asistencias'):
                    verificacionMercado = verifyAsistencia(partido, fixture);
                    break;
                case mercadoNormalizado.includes('jugadorrecibeunatarjeta'):
                    verificacionMercado = verifyPlayerCard(partido, fixture);
                    break;

                // --- Mercados de Córners ---
                case mercadoNormalizado.includes('totalcórneres') && (mercadoOriginal.includes(fixture.teams.home.name.toLowerCase()) || mercadoOriginal.includes(fixture.teams.away.name.toLowerCase())):
                    verificacionMercado = verifyTotalCornersPorEquipo(partido, fixture);
                    break;
                case mercadoNormalizado.includes('hándicapcórner'):
                case mercadoNormalizado.includes('handicapcorner'):
                    verificacionMercado = verifyHandicapCorner(partido, fixture);
                    break;
                case mercadoNormalizado.includes('córnerprimer'):
                    verificacionMercado = verifyPrimerOultimoCorner(partido, fixture, 'primer');
                    break;
                case mercadoNormalizado.includes('últimocórner'):
                case mercadoNormalizado.includes('ultimocorner'):
                    verificacionMercado = verifyPrimerOultimoCorner(partido, fixture, 'ultimo');
                    break;
                case mercadoNormalizado.includes('córnerespar/impar'):
                case mercadoNormalizado.includes('cornerespar/impar'):
                    verificacionMercado = verifyCornersParImpar(partido, fixture);
                    break;

                // --- Mercados de Tarjetas ---
                case mercadoNormalizado.includes('totaltarjetas'):
                    verificacionMercado = verifyTotalTarjetas(partido, fixture);
                    break;
                case mercadoNormalizado.includes('tarjetas1x2'):
                    verificacionMercado = verifyTarjetas1x2(partido, fixture);
                    break;
                case mercadoNormalizado.includes('totaltarjetas') && (mercadoOriginal.includes(fixture.teams.home.name.toLowerCase()) || mercadoOriginal.includes(fixture.teams.away.name.toLowerCase())):
                    verificacionMercado = verifyTotalTarjetasPorEquipo(partido, fixture);
                    break;
                
                // --- Mercados de Rendimiento por Mitades ---
                case mercadoNormalizado.includes('ganaambasmitades'):
                    verificacionMercado = verifyEquipoGanaAmbasMitades(partido, fixture);
                    break;
                case mercadoNormalizado.includes('ganacualquiermitad'):
                    verificacionMercado = verifyEquipoGanaCualquierMitad(partido, fixture);
                    break;
                case mercadoNormalizado.includes('marcaenambaspartes'):
                    verificacionMercado = verifyEquipoMarcaEnAmbasPartes(partido, fixture);
                    break;
                case mercadoNormalizado.includes('remontaráyganará'):
                case mercadoNormalizado.includes('remontarayganara'):
                    verificacionMercado = verifyEquipoRemonta(partido, fixture);
                    break;
                case mercadoNormalizado.includes('córner1x2'):
                case mercadoNormalizado.includes('corner1x2'):
                    verificacionMercado = verifyCorner1x2(partido, fixture);
                    break;

                default:
                    verificacionMercado = {
                        resultadoApuesta: `mercado_no_soportado`,
                        resultadoReal: `Final: ${fixture.goals.home} - ${fixture.goals.away}`
                    };
                    break;
            }
            resultadoApuesta = verificacionMercado.resultadoApuesta;
            resultadoReal = verificacionMercado.resultadoReal;
        }
        
        // 5. Actualizar la BD y devolver el resultado
        const { error: updateError } = await supabase
            .from('Partidos')
            .update({ estado_apuesta: resultadoApuesta, resultado_real: resultadoReal })
            .eq('id', partido.id);

        if (updateError) {
            console.error(`Error al actualizar el partido ${partido.id}:`, updateError.message);
        }

        return {
            partido_id: partido.id,
            partido_verificado: partido.partido,
            tu_seleccion: `${partido.mercado} - ${partido.seleccionado}`,
            resultado_apuesta: resultadoApuesta,
            resultado_real: resultadoReal
        };

    } catch (error) {
        console.error(`Error crítico al verificar el partido ${partido.partido}:`, error.message);
        
        // Si el error es por la API (ej. 429 Too Many Requests), lo reflejamos
        if (error.response && error.response.data) {
            const apiErrorMsg = JSON.stringify(error.response.data.message || error.response.data.errors || error.response.data);
            console.error("Detalle del error de la API:", apiErrorMsg);
            return {
                partido_id: partido.id,
                partido_verificado: partido.partido,
                resultado_apuesta: 'error_api',
                detalle: apiErrorMsg
            };
        }

        return {
            partido_id: partido.id,
            partido_verificado: partido.partido,
            resultado_apuesta: 'error_critico',
            detalle: error.message
        };
    }
}

// --- ENDPOINT PARA VERIFICAR UN TICKET ---
app.post('/api/tickets/:id/verify', async (req, res) => {
    const ticketId = req.params.id;
    console.log(`Solicitud para verificar el ticket ID: ${ticketId}`);

    try {
        // 1. Obtener los datos del ticket y sus partidos desde Supabase
        const { data: ticket, error: ticketError } = await supabase
            .from('Tickets')
            .select('*, Partidos(*)')
            .eq('id', ticketId)
            .single();

        if (ticketError) throw new Error(ticketError.message);
        if (!ticket) return res.status(404).json({ message: 'Ticket no encontrado.' });

        const partidos = ticket.Partidos;
        const fixtureCache = {}; // Caché para almacenar los resultados de la API por fecha

        const apiKey = process.env.API_FOOTBALL_KEY;
        if (!apiKey) {
            throw new Error('La clave de API para API-Football no está configurada en el archivo .env');
        }

        // 2. Verificar cada partido usando la función auxiliar
        const verificationPromises = partidos.map(partido =>
            verifySingleMatch(partido, apiKey, fixtureCache)
        );
        const resultadosVerificacion = await Promise.all(verificationPromises);

        // 3. Determinar el estado final del ticket
        const estadosFinales = resultadosVerificacion.map(r => r.resultado_apuesta);
        let estadoFinalTicket = 'pendiente';

        if (estadosFinales.some(e => e === 'perdida' || e === 'error_critico')) {
            estadoFinalTicket = 'verificado_perdido';
        } else if (estadosFinales.every(e => e === 'ganada')) {
            estadoFinalTicket = 'verificado_ganado';
        } else if (estadosFinales.some(e => e.includes('pendiente') || e.includes('terminado') || e.includes('soportado') || e.includes('error'))) {
            estadoFinalTicket = 'pendiente';
        } else {
            estadoFinalTicket = 'verificado_parcial'; // Para casos mixtos (ej: ganadas y anuladas)
        }

        // 4. Actualizar el ticket principal en la base de datos
        const { error: ticketUpdateError } = await supabase
            .from('Tickets')
            .update({ estado_verificacion: estadoFinalTicket })
            .eq('id', ticketId);

        if (ticketUpdateError) {
            console.error(`Error al actualizar el estado del ticket ${ticketId}:`, ticketUpdateError.message);
        }

        // 5. Enviar la respuesta
        console.log('--- Resultados de la Verificación ---');
        console.log(JSON.stringify(resultadosVerificacion, null, 2));
        console.log(`--- Estado final del ticket: ${estadoFinalTicket} ---`);
        console.log('------------------------------------');

        res.status(200).json({
            message: 'Verificación y actualización completadas.',
            estado_final_ticket: estadoFinalTicket,
            resultados: resultadosVerificacion
        });

    } catch (error) {
        console.error("Error durante la verificación:", error.message);
        res.status(500).json({ message: 'Error en el servidor durante la verificación.', error: error.message });
    }
});

// --- ENDPOINT PARA OBTENER TODOS LOS TICKETS ---
app.get('/api/tickets', async (req, res) => {
    try {
        // Obtenemos todos los tickets y sus partidos asociados
        const { data: tickets, error } = await supabase
            .from('Tickets')
            .select('*, Partidos(*)')
            .order('id', { ascending: false });
        if (error) throw new Error(error.message);
        res.status(200).json({ tickets });
    } catch (error) {
        console.error('Error al obtener los tickets:', error.message);
        res.status(500).json({ message: 'Error al obtener los tickets', error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
    console.log("El backend está listo para recibir tickets.");
});