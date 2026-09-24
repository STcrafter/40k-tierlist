/**
 * Читатель CSV формата Wahapedia.
 *
 * Особенности формата (проверено на public/data/wahapedia):
 * - разделитель полей: '|' (вертикальная черта);
 * - кавычка внутри поля означает ДЮЙМЫ (24", 6") и НЕ является экранированием;
 * - поле экранировано кавычками только когда кавычка стоит в самом начале поля
 *   и поле закрыто кавычкой — тогда внутри работает экранирование "" → ";
 * - в Abilities.csv встречаются поля с '|' внутри кавычек (44 строки), поэтому
 *   ридер обязан быть quote-aware, а не резать строку по разделителю;
 * - переносы строк внутри полей в текущих выгрузках отсутствуют, но state
 *   machine их поддерживает;
 * - файл начинается с BOM, каждая строка заканчивается '|' → «хвостовая»
 *   пустая колонка в заголовке.
 */

export interface CsvTable {
  /** Имена колонок (BOM удалён, значения обрезаны по краям). */
  header: string[];
  /** Строки данных без заголовка. */
  rows: string[][];
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Разбирает текст в таблицу строк. */
export function parseCsv(text: string, delimiter = '|'): CsvTable {
  const src = stripBom(text);
  const all: string[][] = [];

  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true;

  const pushField = () => {
    row.push(field);
    field = '';
    fieldStart = true;
  };
  const pushRow = () => {
    pushField();
    all.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (fieldStart && ch === '"') {
      inQuotes = true;
      fieldStart = false;
      continue;
    }

    if (ch === delimiter) {
      pushField();
      continue;
    }

    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      pushRow();
      continue;
    }

    field += ch;
    fieldStart = false;
  }

  if (field !== '' || row.length > 0) pushRow();

  const headerRow = all.shift() ?? [];
  return {
    header: headerRow.map((h) => h.trim()),
    // Полностью пустые строки (в том числе хвостовой перевод строки в конце файла)
    // отбрасываются, чтобы не превращаться в фантомные записи.
    rows: all.filter((r) => r.some((cell) => cell.trim() !== '')),
  };
}

/**
 * Преобразует таблицу в массив объектов вида «имя колонки → значение».
 * Пустые колонки (в том числе «хвостовая» после последнего '|') отбрасываются,
 * отсутствующие значения приходят как ''.
 */
export function toRecords(table: CsvTable): Array<Record<string, string>> {
  const columns = table.header
    .map((name, index) => ({ name: name.trim(), index }))
    .filter((c) => c.name !== '');

  return table.rows.map((row) => {
    const record: Record<string, string> = {};
    for (const column of columns) {
      record[column.name] = (row[column.index] ?? '').trim();
    }
    return record;
  });
}

/** Удобный шорткат: текст → массив объектов. */
export function parseCsvRecords(text: string, delimiter = '|'): Array<Record<string, string>> {
  return toRecords(parseCsv(text, delimiter));
}
