import { describe, expect, it } from 'vitest';
import { parseCsv, stripBom, toRecords } from './csv.ts';

describe('parseCsv (формат Wahapedia)', () => {
  it('удаляет BOM и разбирает простую таблицу с хвостовым разделителем', () => {
    const text = '\uFEFFid|name|link|\nA|Imperium|https://example.com|';
    const table = parseCsv(text);

    expect(table.header).toEqual(['id', 'name', 'link', '']);
    expect(table.rows).toEqual([['A', 'Imperium', 'https://example.com', '']]);
  });

  it('не трогает кавычку в середине поля — это дюймы', () => {
    const text = 'datasheet_id|name|M|T|\n0001|Warboss|6"|6|';
    const records = toRecords(parseCsv(text));

    expect(records).toEqual([{ datasheet_id: '0001', name: 'Warboss', M: '6"', T: '6' }]);
  });

  it('корректно разбирает экранированное поле с разделителем внутри', () => {
    const text =
      'id|name|legend|faction_id|description|\n' +
      '1|Ability|"legend | with pipe"|TYR|"text with | pipe"|';
    const records = toRecords(parseCsv(text));

    expect(records).toHaveLength(1);
    expect(records[0].legend).toBe('legend | with pipe');
    expect(records[0].description).toBe('text with | pipe');
  });

  it('разделитель без экранирования разрывает поле (особенность формата)', () => {
    const text = 'a|b|\nleft|right | extra|';
    const table = parseCsv(text);

    expect(table.rows[0]).toEqual(['left', 'right ', ' extra', '']);
  });

  it('разворачивает удвоенные кавычки внутри экранированного поля', () => {
    const text = 'id|description|\n1|"say ""hi"" to 6"" range"|';
    const records = toRecords(parseCsv(text));

    expect(records[0].description).toBe('say "hi" to 6" range');
  });

  it('поддерживает перенос строки внутри экранированного поля', () => {
    const text = 'id|description|\n1|"line one\nline two"|';
    const records = toRecords(parseCsv(text));

    expect(records).toHaveLength(1);
    expect(records[0].description).toBe('line one\nline two');
  });

  it('сохраняет пустые поля между разделителями', () => {
    const text = 'a|b|c|d|\n1||3||';
    expect(parseCsv(text).rows[0]).toEqual(['1', '', '3', '', '']);
  });

  it('игнорирует полностью пустые строки', () => {
    const text = 'a|b|\n1|2|\n|';
    expect(parseCsv(text).rows).toHaveLength(1);
  });

  it('stripBom не меняет текст без BOM', () => {
    expect(stripBom('abc')).toBe('abc');
    expect(stripBom('\uFEFFabc')).toBe('abc');
  });
});
