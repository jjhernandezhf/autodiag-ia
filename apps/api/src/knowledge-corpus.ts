import { z } from "zod";

import { containsSensitiveValue, normalizeSafeHttpsUrl } from "./sensitive-data.js";

export const DEMO_SOURCE_LABEL = "AutoDiag IA — Corpus demostrativo interno";

export const knowledgeChunkSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/u),
    chunkIndex: z.number().int().min(0).max(10_000),
    title: z.string().trim().min(1).max(200),
    sourceLabel: z.string().trim().min(1).max(200),
    sourceUrl: z.string().url().refine((value) => normalizeSafeHttpsUrl(value) !== undefined).optional(),
    content: z.string().trim().min(80).max(8_000),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

export type KnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;

export const DEMONSTRATION_KNOWLEDGE_CORPUS: readonly KnowledgeChunk[] = [
  {
    sourceId: "diagnostico-obd-general",
    chunkIndex: 0,
    title: "Secuencia básica de diagnóstico OBD-II",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Un DTC orienta hacia un circuito, una condición o una estrategia de control; no identifica por sí solo una pieza defectuosa. La secuencia prudente registra los códigos y estados, revisa síntomas, consulta información técnica apropiada, inspecciona condiciones básicas y confirma la falla mediante mediciones antes de reemplazar componentes.",
    metadata: { topic: "obd-ii", language: "es" },
  },
  {
    sourceId: "interpretacion-dtc-prudente",
    chunkIndex: 0,
    title: "Interpretación prudente de códigos DTC",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Los códigos actuales, pendientes, confirmados e históricos representan estados distintos. Deben conservarse el módulo de origen y la descripción documental. Códigos relacionados pueden compartir una causa común, pero la similitud entre síntomas o textos no confirma causalidad ni autoriza a omitir las pruebas indicadas por el fabricante.",
    metadata: { topic: "dtc", language: "es" },
  },
  {
    sourceId: "alimentacion-tierra",
    chunkIndex: 0,
    title: "Comprobación de alimentación y tierra",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Antes de condenar un módulo, sensor o actuador, se deben verificar alimentación, fusibles, masa y caída de tensión bajo carga. Una lectura de voltaje sin carga puede parecer correcta aunque exista resistencia en un conector, cable o punto de tierra. Las mediciones deben efectuarse con instrumentos y procedimientos adecuados.",
    metadata: { topic: "electrical", language: "es" },
  },
  {
    sourceId: "bateria-voltaje-bajo",
    chunkIndex: 0,
    title: "Efectos de voltaje bajo de batería",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "El voltaje bajo durante arranque o una alimentación inestable puede generar múltiples DTC, reinicios de módulos y fallos de comunicación. Conviene comprobar estado de carga, capacidad, terminales y comportamiento durante arranque antes de interpretar como independientes todos los códigos almacenados al mismo tiempo.",
    metadata: { topic: "battery", language: "es" },
  },
  {
    sourceId: "conectores-cableado",
    chunkIndex: 0,
    title: "Inspección de conectores y cableado",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "La inspección debe buscar terminales flojos, corrosión, humedad, daño por roce, tensión mecánica y reparaciones previas. Mover un arnés durante una medición puede revelar una falla intermitente, pero debe evitarse provocar cortocircuitos. La continuidad por sí sola no sustituye una prueba de caída de tensión cuando el circuito trabaja con carga.",
    metadata: { topic: "wiring", language: "es" },
  },
  {
    sourceId: "comunicacion-can",
    chunkIndex: 0,
    title: "Diagnóstico inicial de comunicación CAN",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Ante códigos de comunicación se debe identificar qué módulos responden, comprobar alimentación y tierra de los módulos ausentes y revisar la red conforme al diagrama correspondiente. La resistencia, las formas de onda y los voltajes de la red solo deben medirse con el vehículo en el estado indicado para evitar conclusiones erróneas.",
    metadata: { topic: "can", language: "es" },
  },
  {
    sourceId: "comunicacion-can",
    chunkIndex: 1,
    title: "Códigos U y fallas en cascada",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Varios códigos U pueden ser consecuencia de un único módulo sin alimentación, una perturbación de red o un evento de bajo voltaje. Se recomienda priorizar el patrón temporal y los módulos que dejaron de responder, conservar los datos iniciales y evitar sustituir varios módulos basándose únicamente en la cantidad de códigos.",
    metadata: { topic: "can", language: "es" },
  },
  {
    sourceId: "sensores-diagnostico",
    chunkIndex: 0,
    title: "Validación de señales de sensores",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Una señal de sensor fuera de rango puede originarse en el propio sensor, referencia, tierra, cableado, conectores o condiciones físicas reales. Se debe comparar el dato con una magnitud independiente cuando sea posible, observar la señal bajo las condiciones de falla y confirmar que referencia y retorno permanecen estables.",
    metadata: { topic: "sensors", language: "es" },
  },
  {
    sourceId: "actuadores-diagnostico",
    chunkIndex: 0,
    title: "Pruebas seguras de actuadores",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Las pruebas bidireccionales de actuadores deben realizarse solo cuando el movimiento sea seguro y el procedimiento lo permita. Si el actuador no responde, se comprueban alimentación, tierra, señal de mando, carga mecánica y continuidad del circuito antes de atribuir la falla al componente o al módulo de control.",
    metadata: { topic: "actuators", language: "es" },
  },
  {
    sourceId: "modulos-carroceria",
    chunkIndex: 0,
    title: "Módulos de carrocería y funciones compartidas",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Una función de carrocería puede depender de interruptores, módulos de puerta, módulo central, fusibles y mensajes de red. Cuando varias funciones del mismo sector fallan, conviene buscar alimentaciones o conectores compartidos y revisar datos en vivo antes de reemplazar un módulo.",
    metadata: { topic: "body-control", language: "es" },
  },
  {
    sourceId: "retrovisores-actuadores",
    chunkIndex: 0,
    title: "Actuadores eléctricos de retrovisores",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Un retrovisor eléctrico puede combinar motores de ajuste, plegado, calefacción, memoria e interruptores. Una falla debe aislarse por función: confirmar el mando, observar datos o salida del módulo, comprobar el cableado del paso de puerta y medir alimentación del actuador sin forzar el mecanismo.",
    metadata: { topic: "mirror-actuator", language: "es" },
  },
  {
    sourceId: "fallas-intermitentes",
    chunkIndex: 0,
    title: "Tratamiento de fallas intermitentes",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "En una falla intermitente se conservan estados, condiciones de aparición y datos disponibles antes de borrar códigos. La inspección dirigida, el monitoreo durante movimiento controlado del arnés y la repetición en condiciones comparables aportan más evidencia que cambiar piezas sin reproducir el síntoma.",
    metadata: { topic: "intermittent", language: "es" },
  },
  {
    sourceId: "confirmacion-reparacion",
    chunkIndex: 0,
    title: "Confirmación después de la reparación",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Después de una corrección se borran códigos únicamente cuando sea apropiado, se repite la prueba en condiciones comparables y se confirma que la función opera correctamente. También se revisa si regresan DTC y si aparecieron efectos secundarios. La ausencia inmediata de un código no siempre completa un ciclo de verificación.",
    metadata: { topic: "verification", language: "es" },
  },
  {
    sourceId: "seguridad-electrica",
    chunkIndex: 0,
    title: "Seguridad durante diagnóstico eléctrico",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Antes de intervenir circuitos se debe conocer el procedimiento de desconexión, proteger contra cortocircuitos y evitar puentear protecciones. Sistemas de alta corriente, pretensores, bolsas de aire, alto voltaje o movimiento de actuadores requieren precauciones específicas y personal cualificado.",
    metadata: { topic: "safety", language: "es" },
  },
  {
    sourceId: "seguridad-mecanica",
    chunkIndex: 0,
    title: "Seguridad durante pruebas dinámicas",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Las pruebas con motor en marcha o vehículo elevado exigen ventilación, inmovilización adecuada, protección personal y distancia de partes móviles o calientes. Las pruebas de ruta deben asignar la observación de datos a una segunda persona o usar registro seguro para no distraer a quien conduce.",
    metadata: { topic: "safety", language: "es" },
  },
  {
    sourceId: "limites-evidencia",
    chunkIndex: 0,
    title: "Límites de la evidencia recuperada",
    sourceLabel: DEMO_SOURCE_LABEL,
    content: "Una coincidencia semántica indica que un fragmento puede ser pertinente al caso, no que describa el mismo vehículo ni que confirme una reparación. La evidencia recuperada complementa la lectura de DTC y observaciones, pero siempre se contrasta con mediciones, boletines autorizados y documentación técnica aplicable.",
    metadata: { topic: "rag-safety", language: "es" },
  },
] as const;

export function validateKnowledgeCorpus(value: unknown): KnowledgeChunk[] {
  const chunks = z.array(knowledgeChunkSchema).min(12).max(20).parse(value);
  const identities = chunks.map((chunk) => `${chunk.sourceId}:${chunk.chunkIndex}`);
  if (new Set(identities).size !== identities.length) throw new Error("El corpus contiene chunks duplicados.");
  if (chunks.some((chunk) => containsSensitiveValue({
    sourceId: chunk.sourceId,
    title: chunk.title,
    sourceLabel: chunk.sourceLabel,
    content: chunk.content,
    metadata: chunk.metadata,
  }, "source_text"))) {
    throw new Error("El corpus contiene datos sensibles.");
  }
  return chunks;
}
