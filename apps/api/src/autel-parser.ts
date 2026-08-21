import type {
  AutelExtraction,
  ExtractedPdfPage,
  ExtractedTextLine,
  ExtractionWarning,
  ParsedDtc,
  ScannedSystem,
} from "./report-types.js";
import {
  cleanText,
  normalizeDtcStatus,
  normalizeForMatch,
  normalizeVin,
  nullIfMissing,
  parseModuleIdentity,
  protectVin,
} from "./text-normalization.js";

interface LocatedLine extends ExtractedTextLine {
  pageNumber: number;
  normalized: string;
}

interface ModuleDeclaration {
  code: string | null;
  name: string;
  declaredDtcs: number;
}

interface DtcDraft {
  code: string;
  moduleCode: string | null;
  moduleName: string;
  description: string[];
  statusOriginal: string | null;
}

const DTC_CODE_PATTERN = /^[A-Z][A-Z0-9:-]{2,}$/iu;
const STATUS_PATTERN = /(Corriente|Actual|Presente|Almacenado|Guardado|Pendiente|Permanente|Historial|Histórico|Current|Stored|Pending|Permanent|History)$/iu;

const WARNING_MESSAGES: Record<string, string> = {
  VEHICLE_SECTION_MISSING: "No se pudo procesar la sección de información del vehículo.",
  VEHICLE_IDENTITY_UNREADABLE: "No se pudo interpretar la identidad principal del vehículo.",
  SYSTEMS_SECTION_MISSING: "No se pudo procesar la sección de sistemas escaneados.",
  DTC_SECTION_MISSING: "No se pudo procesar la sección de DTC.",
  SYSTEM_COUNT_MISMATCH: "La cantidad de sistemas no coincide con el total declarado.",
  DTC_COUNT_MISMATCH: "La cantidad de DTC no coincide con el total declarado.",
  MODULE_DTC_COUNT_MISMATCH: "La cantidad de DTC de al menos un módulo no coincide con su total declarado.",
  SYSTEM_ROW_UNPARSED: "Al menos una fila de sistemas no pudo interpretarse.",
  DTC_ROW_UNPARSED: "Al menos una fila de DTC no pudo interpretarse.",
  UNKNOWN_DTC_STATUS: "Al menos un estado DTC no pudo normalizarse.",
  VIN_MULTIPLE_CANDIDATES: "Se encontraron varios candidatos de VIN y se requiere revisión manual.",
  VIN_INVALID: "El VIN presente no tiene un formato válido.",
  VIN_NOT_PROVIDED: "El reporte no proporciona un VIN utilizable.",
  ENGINE_NOT_PROVIDED: "El reporte no proporciona información del motor.",
  ODOMETER_NOT_PROVIDED: "El reporte no proporciona una lectura de odómetro utilizable.",
};

function flattenPages(pages: ExtractedPdfPage[]): LocatedLine[] {
  return pages.flatMap((page) =>
    page.lines.map((line) => ({ ...line, pageNumber: page.pageNumber, normalized: normalizeForMatch(line.text) })),
  );
}

function isNoise(line: LocatedLine) {
  const value = line.normalized;
  return (
    value === "" ||
    /^\d+$/u.test(value) ||
    value.includes("tiempo de prueba") ||
    value.includes("id del informe") ||
    value.includes("numero de informe") ||
    value.includes("numero de serie") ||
    value.includes("orden de reparacion") ||
    value.includes("nombre del cliente") ||
    value.includes("tecnico:") ||
    value.includes("descargo de responsabilidad") ||
    value.startsWith("nota:") ||
    value.includes("www.autel.com") ||
    value === "autel"
  );
}

function parseHeadingCount(line: LocatedLine, kind: "systems" | "dtcs") {
  const pattern = kind === "systems" ? /sistema\/?s escaneado\/?s\s*\(\s*(\d+)\s*\)/u : /^dtc\s*\(\s*(\d+)\s*\)/u;
  const match = line.normalized.match(pattern);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

const CHARACTER_GROUPER_PATTERN = /[\p{White_Space}'’ʼ]/u;
const CHARACTER_GROUPERS_PATTERN = /[\p{White_Space}'’ʼ]/gu;
const VALID_CHARACTER_GROUPING_PATTERN = /^\d{1,3}(?:[\p{White_Space}'’ʼ]\d{3})+$/u;
const MAX_ODOMETER_NUMERIC_LENGTH = 512;

interface DecimalFraction {
  numerator: bigint;
  scale: number;
}

function findDecimalPunctuationIndex(value: string) {
  const commaIndex = value.lastIndexOf(",");
  const dotIndex = value.lastIndexOf(".");
  if (commaIndex >= 0 && dotIndex >= 0) return Math.max(commaIndex, dotIndex);

  const separatorIndex = Math.max(commaIndex, dotIndex);
  if (separatorIndex < 0) return -1;
  const separator = value[separatorIndex];
  const occurrences = [...value].filter((character) => character === separator).length;
  const fraction = value.slice(separatorIndex + 1);
  return occurrences === 1 && /^\d{1,2}$/u.test(fraction) ? separatorIndex : -1;
}

function validateAndRemoveCharacterGroupers(raw: string) {
  const value = raw.trim();
  if (!CHARACTER_GROUPER_PATTERN.test(value)) return value;

  const decimalIndex = findDecimalPunctuationIndex(value);
  const integerPart = decimalIndex >= 0 ? value.slice(0, decimalIndex) : value;
  const decimalPart = decimalIndex >= 0 ? value.slice(decimalIndex) : "";
  if (!VALID_CHARACTER_GROUPING_PATTERN.test(integerPart)) return null;
  if (decimalPart && !/^[.,]\d+$/u.test(decimalPart)) return null;
  return `${integerPart.replace(CHARACTER_GROUPERS_PATTERN, "")}${decimalPart}`;
}

function normalizeDecimalFraction(fraction: DecimalFraction): DecimalFraction {
  let { numerator, scale } = fraction;
  if (numerator === 0n) return { numerator: 0n, scale: 0 };
  while (scale > 0 && numerator % 10n === 0n) {
    numerator /= 10n;
    scale -= 1;
  }
  return { numerator, scale };
}

function parseExactDecimal(value: string, allowScientificNotation = false): DecimalFraction | null {
  if (value.length === 0 || value.length > MAX_ODOMETER_NUMERIC_LENGTH) return null;
  const pattern = allowScientificNotation
    ? /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu
    : /^(\d+)(?:\.(\d+))?$/u;
  const match = value.match(pattern);
  if (!match?.[1]) return null;

  const fractionDigits = match[2] ?? "";
  const exponent = match[3] ? Number.parseInt(match[3], 10) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_ODOMETER_NUMERIC_LENGTH) return null;

  let numerator = BigInt(`${match[1]}${fractionDigits}`);
  let scale = fractionDigits.length - exponent;
  if (scale < 0) {
    numerator *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return normalizeDecimalFraction({ numerator, scale });
}

function decimalFractionsEqual(left: DecimalFraction, right: DecimalFraction) {
  return left.numerator === right.numerator && left.scale === right.scale;
}

function parseNumericOdometer(raw: string) {
  if (raw.length > MAX_ODOMETER_NUMERIC_LENGTH) return null;
  const compact = validateAndRemoveCharacterGroupers(raw);
  if (compact === null) return null;
  if (!/^\d+(?:[.,]\d+)*$/u.test(compact)) return null;

  const commaCount = (compact.match(/,/gu) ?? []).length;
  const dotCount = (compact.match(/\./gu) ?? []).length;
  let normalized: string;
  let fractionalDigits = 0;

  if (commaCount > 0 && dotCount > 0) {
    const decimalSeparator = compact.lastIndexOf(",") > compact.lastIndexOf(".") ? "," : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    if ((decimalSeparator === "," ? commaCount : dotCount) !== 1) return null;

    const [integerPart, fraction, ...extraParts] = compact.split(decimalSeparator);
    if (!integerPart || !fraction || extraParts.length > 0 || !/^\d+$/u.test(fraction)) return null;
    const escapedGrouping = groupingSeparator === "." ? "\\." : ",";
    if (!new RegExp(`^\\d{1,3}(?:${escapedGrouping}\\d{3})*$`, "u").test(integerPart)) return null;
    normalized = `${integerPart.replaceAll(groupingSeparator, "")}.${fraction}`;
    fractionalDigits = fraction.length;
  } else {
    const separator = commaCount > 0 ? "," : dotCount > 0 ? "." : null;
    if (!separator) {
      normalized = compact;
    } else {
      const parts = compact.split(separator);
      const lastGroup = parts.at(-1) ?? "";
      if (parts.length === 2 && /^\d{1,2}$/u.test(lastGroup)) {
        normalized = `${parts[0]}.${lastGroup}`;
        fractionalDigits = lastGroup.length;
      } else if (parts.length === 2 && parts[0] === "0" && /^\d{4,}$/u.test(lastGroup)) {
        normalized = `0.${lastGroup}`;
        fractionalDigits = lastGroup.length;
      } else if (/^\d{1,3}$/u.test(parts[0] ?? "") && parts.slice(1).every((part) => /^\d{3}$/u.test(part))) {
        normalized = parts.join("");
      } else {
        return null;
      }
    }
  }

  const sourceFraction = parseExactDecimal(normalized);
  if (!sourceFraction || sourceFraction.numerator > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || (fractionalDigits === 0 && !Number.isSafeInteger(value))) return null;
  const returnedFraction = parseExactDecimal(value.toString(), true);
  if (!returnedFraction || !decimalFractionsEqual(sourceFraction, returnedFraction)) return null;
  return value;
}

export function parseOdometer(raw: string) {
  const match = raw.match(/lectura del od[oó]metro\s*:\s*(--|[\d.,\p{White_Space}'’ʼ]+\s*(?:km|mi))/iu);
  if (!match || match[1] === "--") return null;
  const odometerValue = match[1];
  if (!odometerValue) return null;
  const unitMatch = odometerValue.match(/(km|mi)$/iu);
  if (!unitMatch?.[1]) return null;
  const unit = unitMatch[1].toLowerCase() as "km" | "mi";
  const value = parseNumericOdometer(odometerValue.slice(0, unitMatch.index ?? odometerValue.length));
  return value === null ? null : { value, unit };
}

function extractVehicle(lines: LocatedLine[], startIndex: number, endIndex: number) {
  let year: number | null = null;
  let make: string | null = null;
  let model: string | null = null;
  let engine: string | null = null;
  let odometer: { value: number; unit: "km" | "mi" } | null = null;
  const vinCandidates = new Set<string>();

  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const odometerCandidate = parseOdometer(line.text);
    if (odometerCandidate) odometer = odometerCandidate;

    const vinMatch = line.text.match(/\bVIN\s*:\s*(--|[A-HJ-NPR-Z0-9]{5,})/iu);
    if (vinMatch?.[1] && vinMatch[1] !== "--") vinCandidates.add(cleanText(vinMatch[1]).toUpperCase());

    const engineMatch = line.text.match(/\b(?:Motor|Engine)\s*:\s*([^:]+?)(?=\s{2,}|$)/iu);
    if (engineMatch?.[1]) engine = nullIfMissing(engineMatch[1]);

    const routePortion = line.text.split(/\b(?:Lectura del od[oó]metro|VIN|Matr[ií]cula|Motor|Engine)\s*:/iu)[0] ?? "";
    if (routePortion.includes("/") && /(?:19|20)\d{2}/u.test(routePortion)) {
      const segments = routePortion.split("/").map(cleanText);
      const yearMatch = segments[0]?.match(/(?:19|20)\d{2}/u);
      if (yearMatch) year = Number.parseInt(yearMatch[0], 10);
      make = nullIfMissing(segments[1]);
      model = nullIfMissing(segments[2]);
      if (!engine) engine = nullIfMissing(segments[3]);
    }
  }

  return { year, make, model, engine, odometer, vinCandidates: [...vinCandidates] };
}

function isSystemsTableHeader(line: LocatedLine) {
  return line.normalized.includes("sistema") && line.normalized.includes("estado/dtc");
}

function parseSystems(lines: LocatedLine[], startIndex: number, endIndex: number, markCritical: (code: string) => void) {
  const systems: ScannedSystem[] = [];
  const pendingName: string[] = [];
  const sectionLines = lines.slice(startIndex + 1, endIndex);
  const consumed = new Set<number>();

  const addSystem = (rawName: string, count: number) => {
    const combinedName = cleanText(rawName);
    if (!combinedName) {
      markCritical("SYSTEM_ROW_UNPARSED");
      return;
    }
    const identity = parseModuleIdentity(combinedName);
    systems.push({ ...identity, dtcCount: count });
  };

  for (let index = 0; index < sectionLines.length; index += 1) {
    const countLine = sectionLines[index]!;
    const countMatch = countLine.text.match(/^(\d+)$/u);
    const countX = Math.min(...countLine.fragments.map((fragment) => fragment.x));
    if (!countMatch?.[1] || countX < 250) continue;

    const nameIndexes = sectionLines
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate, candidateIndex }) =>
        candidateIndex !== index &&
        candidate.pageNumber === countLine.pageNumber &&
        Math.abs(candidate.y - countLine.y) <= 18 &&
        !isNoise(candidate) &&
        !isSystemsTableHeader(candidate) &&
        !/\s\d+\s*$/u.test(candidate.text) &&
        !/^\d+$/u.test(candidate.text),
      )
      .sort((left, right) => right.candidate.y - left.candidate.y);

    if (nameIndexes.length === 0) continue;
    addSystem(nameIndexes.map(({ candidate }) => candidate.text).join(" "), Number.parseInt(countMatch[1], 10));
    consumed.add(index);
    for (const { candidateIndex } of nameIndexes) consumed.add(candidateIndex);
  }

  for (let index = 0; index < sectionLines.length; index += 1) {
    if (consumed.has(index)) continue;
    const line = sectionLines[index]!;
    if (isNoise(line) || isSystemsTableHeader(line)) continue;
    const rowMatch = line.text.match(/^(.*?)\s+(\d+)\s*$/u);
    if (rowMatch?.[1] !== undefined && rowMatch[2] !== undefined) {
      const combinedName = cleanText([...pendingName, rowMatch[1]].join(" "));
      pendingName.length = 0;
      addSystem(combinedName, Number.parseInt(rowMatch[2], 10));
      continue;
    }

    if (line.text.trim()) pendingName.push(line.text);
  }

  if (pendingName.length > 0) markCritical("SYSTEM_ROW_UNPARSED");
  return systems;
}

function findColumnX(line: LocatedLine, name: string) {
  const fragment = line.fragments.find((candidate) => normalizeForMatch(candidate.text).includes(name));
  return fragment?.x ?? null;
}

function parseDtcRow(line: LocatedLine, descriptionColumnX: number | null, statusColumnX: number | null) {
  const fragments = line.fragments.filter((fragment) => fragment.text.trim() !== "").sort((left, right) => left.x - right.x);
  const firstText = cleanText(fragments[0]?.text ?? "");
  const beginsInCodeColumn = descriptionColumnX === null || (fragments[0]?.x ?? Number.POSITIVE_INFINITY) < descriptionColumnX - 4;
  let code: string | null = beginsInCodeColumn && DTC_CODE_PATTERN.test(firstText) ? firstText.toUpperCase() : null;

  if (!code && beginsInCodeColumn) {
    const match = line.text.match(/^([A-Z][A-Z0-9:-]{2,})\s+(.+)$/iu);
    if (!match?.[1]) return null;
    code = match[1].toUpperCase();
  }
  if (!code) return null;

  let statusOriginal: string | null = null;
  let description = "";

  if (fragments.length >= 2 && firstText.toUpperCase() === code) {
    const descriptionFragments = fragments.filter((fragment, index) => {
      if (index === 0) return false;
      if (statusColumnX !== null && fragment.x >= statusColumnX - 4) return false;
      return descriptionColumnX === null || fragment.x >= descriptionColumnX - 4;
    });
    const statusFragments = statusColumnX === null ? fragments.slice(-1) : fragments.filter((fragment) => fragment.x >= statusColumnX - 4);
    description = cleanText(descriptionFragments.map((fragment) => fragment.text).join(" "));
    statusOriginal = nullIfMissing(statusFragments.map((fragment) => fragment.text).join(" "));
  }

  if (!description) {
    const remainder = cleanText(line.text.slice(line.text.toUpperCase().indexOf(code) + code.length));
    const statusMatch = remainder.match(STATUS_PATTERN);
    statusOriginal = statusMatch?.[1] ? cleanText(statusMatch[1]) : statusOriginal;
    description = cleanText(statusMatch?.index === undefined ? remainder : remainder.slice(0, statusMatch.index));
  }

  return { code, description, statusOriginal };
}

function parseDtcs(lines: LocatedLine[], startIndex: number, markCritical: (code: string) => void) {
  const dtcs: ParsedDtc[] = [];
  const moduleDeclarations: ModuleDeclaration[] = [];
  let currentModule: ModuleDeclaration | null = null;
  let currentDtc: DtcDraft | null = null;
  let descriptionColumnX: number | null = null;
  let statusColumnX: number | null = null;
  const pendingModuleParts: string[] = [];

  const finalizeDtc = () => {
    if (!currentDtc) return;
    const descriptionOriginal = cleanText(currentDtc.description.join(" "));
    if (!descriptionOriginal) markCritical("DTC_ROW_UNPARSED");
    const status = normalizeDtcStatus(currentDtc.statusOriginal);
    if (status === "unknown") markCritical("UNKNOWN_DTC_STATUS");
    dtcs.push({
      code: currentDtc.code,
      moduleCode: currentDtc.moduleCode,
      moduleName: currentDtc.moduleName,
      status,
      statusOriginal: currentDtc.statusOriginal,
      descriptionOriginal,
    });
    currentDtc = null;
  };

  for (const line of lines.slice(startIndex + 1)) {
    if (isNoise(line)) continue;
    if (line.normalized.startsWith("numero informe")) break;

    const moduleMatch = line.text.match(/^(.*)\(\s*(\d+)\s*DTC\s*\)\s*$/iu);
    if (moduleMatch?.[1] && moduleMatch[2] !== undefined) {
      finalizeDtc();
      const moduleLabel = cleanText([...pendingModuleParts, moduleMatch[1]].join(" "));
      pendingModuleParts.length = 0;
      const identity = parseModuleIdentity(moduleLabel);
      currentModule = { ...identity, declaredDtcs: Number.parseInt(moduleMatch[2], 10) };
      moduleDeclarations.push(currentModule);
      continue;
    }

    if (line.normalized.includes("dtc") && line.normalized.includes("descripcion") && line.normalized.includes("estado")) {
      if (pendingModuleParts.length > 0) {
        markCritical("DTC_ROW_UNPARSED");
        pendingModuleParts.length = 0;
      }
      descriptionColumnX = findColumnX(line, "descripcion");
      statusColumnX = findColumnX(line, "estado");
      continue;
    }

    const parsedRow = parseDtcRow(line, descriptionColumnX, statusColumnX);
    if (parsedRow) {
      finalizeDtc();
      if (!currentModule) markCritical("DTC_ROW_UNPARSED");
      currentDtc = {
        code: parsedRow.code,
        moduleCode: currentModule?.code ?? null,
        moduleName: currentModule?.name ?? "Módulo no identificado",
        description: parsedRow.description ? [parsedRow.description] : [],
        statusOriginal: parsedRow.statusOriginal,
      };
      continue;
    }

    const firstFragmentX = Math.min(...line.fragments.map((fragment) => fragment.x));
    const beginsBeforeDescription = descriptionColumnX !== null && firstFragmentX < descriptionColumnX - 4;
    if ((!currentDtc && line.text.trim()) || beginsBeforeDescription) {
      finalizeDtc();
      pendingModuleParts.push(line.text);
    } else if (currentDtc) {
      const continuation = cleanText(
        line.fragments
          .filter((fragment) => (descriptionColumnX === null || fragment.x >= descriptionColumnX - 4) && (statusColumnX === null || fragment.x < statusColumnX - 4))
          .map((fragment) => fragment.text)
          .join(" ") || line.text,
      );
      if (continuation) currentDtc.description.push(continuation);
    } else if (line.text.trim()) {
      markCritical("DTC_ROW_UNPARSED");
    }
  }
  finalizeDtc();
  if (pendingModuleParts.length > 0) markCritical("DTC_ROW_UNPARSED");

  for (const module of moduleDeclarations) {
    const parsedCount = dtcs.filter((dtc) =>
      module.code ? dtc.moduleCode === module.code : normalizeForMatch(dtc.moduleName) === normalizeForMatch(module.name),
    ).length;
    if (parsedCount !== module.declaredDtcs) markCritical("MODULE_DTC_COUNT_MISMATCH");
  }

  return dtcs;
}

export function parseAutelReport(pages: ExtractedPdfPage[], vinHmacSecret: string): AutelExtraction {
  const lines = flattenPages(pages);
  const warnings: ExtractionWarning[] = [];
  const warningCodes = new Set<string>();
  const criticalCodes = new Set<string>();

  const addWarning = (code: string, critical = false) => {
    if (!warningCodes.has(code)) warnings.push({ code, message: WARNING_MESSAGES[code] ?? "Se requiere revisión manual." });
    warningCodes.add(code);
    if (critical) criticalCodes.add(code);
  };
  const markCritical = (code: string) => addWarning(code, true);

  const vehicleIndex = lines.findIndex((line) => line.normalized === "informacion del vehiculo");
  const systemsIndex = lines.findIndex((line) => parseHeadingCount(line, "systems") !== null);
  const dtcIndex = lines.findIndex((line) => parseHeadingCount(line, "dtcs") !== null);

  if (vehicleIndex < 0) markCritical("VEHICLE_SECTION_MISSING");
  if (systemsIndex < 0) markCritical("SYSTEMS_SECTION_MISSING");
  if (dtcIndex < 0) markCritical("DTC_SECTION_MISSING");

  const emptyVehicle = { year: null, make: null, model: null, engine: null, odometer: null, vinCandidates: [] as string[] };
  const rawVehicle = vehicleIndex >= 0 ? extractVehicle(lines, vehicleIndex, systemsIndex >= 0 ? systemsIndex : lines.length) : emptyVehicle;
  const systems = systemsIndex >= 0 ? parseSystems(lines, systemsIndex, dtcIndex >= 0 ? dtcIndex : lines.length, markCritical) : [];
  const dtcs = dtcIndex >= 0 ? parseDtcs(lines, dtcIndex, markCritical) : [];
  const declaredSystems = systemsIndex >= 0 ? parseHeadingCount(lines[systemsIndex]!, "systems") : null;
  const declaredDtcs = dtcIndex >= 0 ? parseHeadingCount(lines[dtcIndex]!, "dtcs") : null;

  if (declaredSystems === null || declaredSystems !== systems.length) markCritical("SYSTEM_COUNT_MISMATCH");
  if (declaredDtcs === null || declaredDtcs !== dtcs.length) markCritical("DTC_COUNT_MISMATCH");
  if (rawVehicle.year === null && rawVehicle.make === null && rawVehicle.model === null) {
    markCritical("VEHICLE_IDENTITY_UNREADABLE");
  }

  for (const system of systems) {
    const parsedCount = dtcs.filter((dtc) =>
      system.code ? dtc.moduleCode === system.code : normalizeForMatch(dtc.moduleName) === normalizeForMatch(system.name),
    ).length;
    if (parsedCount !== system.dtcCount) markCritical("MODULE_DTC_COUNT_MISMATCH");
  }

  let normalizedVin: string | null = null;
  if (rawVehicle.vinCandidates.length > 1) {
    markCritical("VIN_MULTIPLE_CANDIDATES");
  } else if (rawVehicle.vinCandidates.length === 1) {
    normalizedVin = normalizeVin(rawVehicle.vinCandidates[0]!);
    if (!normalizedVin) markCritical("VIN_INVALID");
  } else {
    addWarning("VIN_NOT_PROVIDED");
  }
  if (!rawVehicle.engine) addWarning("ENGINE_NOT_PROVIDED");
  if (!rawVehicle.odometer) addWarning("ODOMETER_NOT_PROVIDED");

  const protectedVin = protectVin(normalizedVin, vinHmacSecret);
  const partial = criticalCodes.size > 0;

  return {
    status: partial ? "partial" : "completed",
    format: "autel_vehicle_diagnostic_report",
    requiresManualReview: partial,
    vehicle: {
      year: rawVehicle.year,
      make: rawVehicle.make,
      model: rawVehicle.model,
      engine: rawVehicle.engine,
      odometer: rawVehicle.odometer,
      ...protectedVin,
    },
    scanSummary: {
      declaredSystems,
      parsedSystems: systems.length,
      declaredDtcs,
      parsedDtcs: dtcs.length,
    },
    systems,
    dtcs,
    warnings,
  };
}
