// src/data/csv-parser.ts

/**
 * Парсер CSV для формата Wahapedia
 *
 * Особенности формата:
 * - Разделитель: |
 * - Кавычки " внутри полей обозначают дюймы (24", 6" и т.д.) — это НЕ экранирование
 * - Экранирование кавычками только когда поле ОБЁРНУТО кавычками с обеих сторон
 *   (для полей с переносами строк или символом | внутри)
 * - Двойные кавычки "" внутри экранированного поля = одна кавычка
 */
export function parseCSV<T extends Record<string, any>>(
  text: string,
  separator: string = '|'
): T[] {
  const lines = splitLines(text);
  if (lines.length < 2) return [];

  const headers = parseLine(lines[0], separator).map((h) => h.trim());
  console.log(`📋 Заголовки (${headers.length}):`, headers);

  const rows: T[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let values = parseLine(line, separator);

    // Убираем хвостовые пустые поля (артефакты экспорта)
    while (values.length > headers.length && values[values.length - 1].trim() === '') {
      values.pop();
    }
    // Добиваем пустыми, если полей не хватает
    while (values.length < headers.length) {
      values.push('');
    }

    if (values.length !== headers.length) {
      console.warn(`⚠️ Строка ${i + 1}: необъяснимое расхождение полей`, values);
      continue;
    }

    const row: Record<string, any> = {};
    headers.forEach((header, idx) => {
      row[header] = normalizeValue(values[idx]);
    });
    rows.push(row as T);
  }

  console.log(`✅ Распарсено ${rows.length} из ${lines.length - 1} строк`);
  return rows;
}

/**
 * Разбивает текст на строки.
 *
 * Логика:
 * - Строка начинается в "обычном" режиме
 * - Если поле начинается с " — включаем "экранированный" режим до закрывающей "
 * - Переносы строк в экранированном режиме не считаются концом строки
 */
function splitLines(text: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotedField = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    // Начало поля в кавычках: " сразу после разделителя или в начале
    if (
      char === '"' &&
      !inQuotedField &&
      (current === '' || current.endsWith('|'))
    ) {
      inQuotedField = true;
      current += char;
      i++;
      continue;
    }

    // Конец экранированного поля
    if (char === '"' && inQuotedField) {
      // Экранированная кавычка ""
      if (i + 1 < text.length && text[i + 1] === '"') {
        current += '""';
        i += 2;
        continue;
      }
      // Закрывающая кавычка: перед разделителем, переносом строки или концом
      const next = text[i + 1];
      if (next === undefined || next === '|' || next === '\n' || next === '\r') {
        inQuotedField = false;
        current += char;
        i++;
        continue;
      }
      // Кавычка в середине (дюймы) — оставляем как есть
      current += char;
      i++;
      continue;
    }

    // Перенос строки вне экранированного поля — конец строки
    if ((char === '\n' || char === '\r') && !inQuotedField) {
      if (current.trim()) {
        result.push(current);
      }
      current = '';
      if (char === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }

    current += char;
    i++;
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}

/**
 * Разбирает одну строку на значения.
 *
 * Логика:
 * - Поле, начинающееся с " — экранированное (до закрывающей ")
 * - Остальные поля — просто текст до следующего разделителя
 */
function parseLine(line: string, separator: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotedField = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    // Начало экранированного поля: " в самом начале поля
    if (
      char === '"' &&
      !inQuotedField &&
      current === ''
    ) {
      inQuotedField = true;
      i++; // пропускаем открывающую кавычку
      continue;
    }

    // Внутри экранированного поля
    if (inQuotedField) {
      if (char === '"') {
        // Экранированная кавычка ""
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        // Закрывающая кавычка
        inQuotedField = false;
        i++; // пропускаем закрывающую кавычку
        continue;
      }
      current += char;
      i++;
      continue;
    }

    // Разделитель
    if (line.substring(i, i + separator.length) === separator) {
      result.push(current);
      current = '';
      i += separator.length;
      continue;
    }

    // Обычный символ (включая " в середине — это дюймы)
    current += char;
    i++;
  }

  result.push(current);
  return result;
}

/**
 * Нормализует значение
 */
function normalizeValue(value: string): any {
  const trimmed = value.trim();

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === '') return '';

  return trimmed;
}

export const __testing = { parseLine, splitLines, normalizeValue };