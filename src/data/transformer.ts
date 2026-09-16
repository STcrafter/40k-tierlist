// src/data/transformer.ts

import {
  WahapediaData,
  WahapediaDatasheet,
  WahapediaWargear,
  WahapediaCost,
} from './types/wahapedia';
import {
  Unit,
  WeaponProfile,
  WeaponAbility,
  DiceValue,
  UnitCategory,
  UnitRole,
  LoadoutEntry,
} from './types/unit';

export class UnitTransformer {
  constructor(private data: WahapediaData) {}

  // =========================================================
  // === Главный метод трансформации
  // =========================================================

  transform(datasheetId: string): Unit | null {
    const datasheet = this.data.datasheets.find((d) => d.id === datasheetId);
    if (!datasheet) {
      console.warn(`Transformer: datasheet ${datasheetId} не найден`);
      return null;
    }
    if (datasheet.virtual) return null;

    const models = this.data.models.filter((m) => m.datasheet_id === datasheetId);
    const costs = this.data.costs.filter((c) => c.datasheet_id === datasheetId);
    const keywords = this.data.keywords.filter((k) => k.datasheet_id === datasheetId);

    if (models.length === 0) {
      console.warn(`Transformer: нет моделей для ${datasheet.name}`);
      return null;
    }
    if (costs.length === 0) {
      console.warn(`⚠️ Пропущен (no cost): ${datasheet.name}`);
      return null;
    }

    const primaryModel = models[0];

    // === Состав отряда ===
    const compositionLines = this.parseCompositionLines(datasheet.id);
    const compositionModels =
      compositionLines.length > 0
        ? compositionLines.reduce((sum, l) => sum + l.count, 0)
        : null;

    // === Стоимость ===
    const { points, modelsCount: costModels } = this.parseCost(costs, compositionModels);
    const modelsCount = compositionModels ?? costModels;

    // === Каталог оружия и базовая комплектация ===
    const { catalog, all } = this.buildCatalog(datasheet.id);

    let baseEntries = this.parseLoadoutEntries(
      datasheet,
      modelsCount,
      catalog,
      compositionLines
    );

    if (baseEntries.length === 0) {
      console.warn(`⚠️ ${datasheet.name}: loadout не распарсился, fallback-эвристика`);
      baseEntries = this.fallbackBaseEntries(datasheet.id, catalog, modelsCount);
    }

    const optionDescriptions = this.data.options
      .filter((o) => o.datasheet_id === datasheet.id)
      .map((o) => o.description);

    // === Ключевые слова ===
    const allKeywords = keywords.map((k) => k.keyword);
    const factionKeywords = keywords
      .filter((k) => k.is_faction_keyword)
      .map((k) => k.keyword);

    const faction = this.data.factions.find((f) => f.id === datasheet.faction_id);

    // === Опции = профили каталога, не вошедшие в базу ===
    const baseNames = new Set(baseEntries.map((e) => e.weapon.name));
    const optionWeapons = all.filter((w) => !baseNames.has(w.name));

    const unit: Unit = {
      id: datasheet.id,
      name: datasheet.name,
      faction: faction?.name || 'Unknown',
      factionId: datasheet.faction_id,
      role: datasheet.role,
      link: datasheet.link,

      category: UnitCategory.UNKNOWN,
      predictedRole: UnitRole.STRIKER,

      points,
      pointsPerModel: modelsCount > 0 ? points / modelsCount : points,
      models: modelsCount,

      toughness: this.parseStat(primaryModel.T),
      save: this.parseSaveStat(primaryModel.Sv),
      invulnerableSave: this.parseSaveStat(primaryModel.inv_sv),
      wounds: this.parseStat(primaryModel.W),
      woundsTotal: this.parseStat(primaryModel.W) * modelsCount,
      feelNoPain: null,
      damageReduction: 0,
      minusToWound: 0,
      stealth: false,

      movement: this.parseMovement(primaryModel.M),
      objectiveControl: this.parseStat(primaryModel.OC),
      objectiveControlTotal: this.parseStat(primaryModel.OC) * modelsCount,

      weapons: baseEntries.map((e) => ({ ...e.weapon, count: e.count })),
      baseEntries,
      weaponCatalog: all,
      optionDescriptions,
      optionWeapons,

      keywords: allKeywords,
      factionKeywords,
      hasInfiltrate: this.hasKeyword(allKeywords, 'INFILTRATOR'),
      hasScout: this.hasKeyword(allKeywords, 'SCOUTS'),
      hasFly: this.hasKeyword(allKeywords, 'FLY'),
      hasDeepStrike: this.hasKeyword(allKeywords, 'DEEP STRIKE'),
    };

    unit.category = this.categorize(unit);
    unit.predictedRole = this.predictRole(unit);

    // === ОТЛАДКА (временно): правильное место — здесь, внутри transform() ===
    if (datasheet.name === 'Intercessor Squad') {
      console.log('baseEntries:', baseEntries.map((e) => `${e.weapon.name} ×${e.count}`));
      console.log('catalog:', [...catalog.keys()]);
      console.log('options:', optionDescriptions.length, 'текстов');
    }

    return unit;
  }

  /**
   * Трансформирует все datasheets + статистика пропусков.
   */
  transformAll(): { units: Unit[]; skipped: Map<string, number> } {
    const units: Unit[] = [];
    const skipped = new Map<string, number>();
    const bump = (reason: string) =>
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

    for (const datasheet of this.data.datasheets) {
      if (datasheet.virtual) {
        bump('virtual');
        continue;
      }
      const models = this.data.models.filter((m) => m.datasheet_id === datasheet.id);
      if (models.length === 0) {
        bump('no models');
        continue;
      }
      const costs = this.data.costs.filter((c) => c.datasheet_id === datasheet.id);
      if (costs.length === 0) {
        bump('no cost');
        continue;
      }

      const unit = this.transform(datasheet.id);
      if (unit) units.push(unit);
      else bump('transform failed');
    }

    console.log(`✅ Трансформировано ${units.length} юнитов`);
    console.log('⚠️ Пропущено:', Object.fromEntries(skipped));
    return { units, skipped };
  }

  // =========================================================
  // === Каталог и состав
  // =========================================================

  /**
   * Каталог оружия: группа → первичный профиль (liw=1),
   * all — все профили подряд (включая альт-режимы).
   */
  private buildCatalog(datasheetId: string): {
    catalog: Map<string, WeaponProfile>;
    all: WeaponProfile[];
  } {
    const rows = this.data.wargear.filter((w) => w.datasheet_id === datasheetId);
    const all = rows.map((w) => this.transformWeapon(w));

    const catalog = new Map<string, WeaponProfile>();
    for (let i = 0; i < rows.length; i++) {
      const group = this.normalizeWeaponName(rows[i].name);
      if (!catalog.has(group)) catalog.set(group, all[i]);
    }

    return { catalog, all };
  }

  /**
   * "1 Intercessor Sergeant" → { name: 'intercessor sergeant', count: 1 }
   * "4-9 Intercessors"      → { name: 'intercessors', count: 4 }
   */
  private parseCompositionLines(datasheetId: string): Array<{ name: string; count: number }> {
    const rows = this.data.composition.filter((c) => c.datasheet_id === datasheetId);
    const lines: Array<{ name: string; count: number }> = [];

    for (const row of rows) {
      const m = row.description.match(/^\s*(\d+)\s*(?:-\s*\d+)?\s+(.+)$/);
      if (m) {
        lines.push({ count: parseInt(m[1], 10), name: m[2].trim().toLowerCase() });
      }
    }

    return lines;
  }

  // =========================================================
  // === Loadout: база с количествами
  // =========================================================

  /**
   * Парсит поле loadout в базовую комплектацию с количествами.
   * Сегменты с "can be" — опции, пропускаются.
   */
  private parseLoadoutEntries(
    datasheet: WahapediaDatasheet,
    modelsCount: number,
    catalog: Map<string, WeaponProfile>,
    compositionLines: Array<{ name: string; count: number }>
  ): LoadoutEntry[] {
    if (!datasheet.loadout) return [];

    const text = datasheet.loadout.replace(/<[^>]+>/g, ' ');
    const segments = text.split(/[.|]/);
    const entries: LoadoutEntry[] = [];

    for (const segment of segments) {
      if (!/equipped with/i.test(segment)) continue;
      if (/can be/i.test(segment)) continue;

      // === Количество моделей ===
      let count: number | null = null;

      if (/every model/i.test(segment)) {
        count = modelsCount;
      } else {
        const numModels = segment.match(/(\d+)\s+models?/i);
        if (numModels) {
          count = parseInt(numModels[1], 10);
        } else {
          for (const line of compositionLines) {
            if (segment.toLowerCase().includes(line.name)) {
              count = line.count;
              break;
            }
          }
          if (
            count === null &&
            /sergeant|champion|leader|boss|alpha|veteran\s+guard/i.test(segment)
          ) {
            count = 1;
          }
        }
      }

      if (count === null) {
        console.warn(
          `⚠️ ${datasheet.name}: не распознан квантор в loadout, беру весь отряд:`,
          segment.trim()
        );
        count = modelsCount;
      }

      // === Список оружия ===
      const idx = segment.toLowerCase().indexOf('equipped with');
      const list = segment.slice(idx + 'equipped with'.length).replace(/^[:\s]+/, '');

      for (let token of list.split(/[;,]|\band\b/)) {
        token = token
          .trim()
          .replace(/^\d+\s*/, '')
          .replace(/^a\s+/i, '')
          .trim();
        if (!token) continue;

        const group = this.normalizeWeaponName(token);
        const profile = catalog.get(group);

        if (profile) {
          entries.push({ weapon: profile, count });
        } else {
          console.warn(
            `⚠️ ${datasheet.name}: оружие из loadout не найдено в каталоге: "${token}"`
          );
        }
      }
    }

    return entries;
  }

  /** Fallback: каталог минус опции, всё на весь отряд */
  private fallbackBaseEntries(
    datasheetId: string,
    catalog: Map<string, WeaponProfile>,
    modelsCount: number
  ): LoadoutEntry[] {
    const optionNames = this.parseOptionNames(datasheetId);
    const entries: LoadoutEntry[] = [];

    for (const [group, profile] of catalog) {
      if (optionNames.has(group)) continue;
      entries.push({ weapon: profile, count: modelsCount });
    }

    return entries;
  }

  /** Имена опционных оружий из <li> списков Datasheets_options */
  private parseOptionNames(datasheetId: string): Set<string> {
    const names = new Set<string>();
    const rows = this.data.options.filter((o) => o.datasheet_id === datasheetId);

    for (const row of rows) {
      const liRegex = /<li>\s*(?:\d+\s+)?([^<]+?)\s*<\/li>/gi;
      let m: RegExpExecArray | null;
      while ((m = liRegex.exec(row.description)) !== null) {
        names.add(this.normalizeWeaponName(m[1]));
      }
    }
    return names;
  }

  /** "Plasma pistol – supercharge" → "plasma pistol" */
  private normalizeWeaponName(name: string): string {
    return name.split('–')[0].split('-')[0].trim().toLowerCase();
  }

  // =========================================================
  // === Парсинг оружия
  // =========================================================

  private transformWeapon(wargear: WahapediaWargear): WeaponProfile {
    const abilities = this.parseWeaponAbilities(wargear.description);
    const bsUpper = (wargear.BS_WS || '').trim().toUpperCase();
    const autoHit =
      bsUpper === 'N/A' || bsUpper === '-' || abilities.includes(WeaponAbility.TORRENT);

    return {
      name: wargear.name,
      range: this.parseRange(wargear.range),
      attacks: this.parseDice(wargear.A),
      skill: this.parseSkill(wargear.BS_WS),
      strength: this.parseStat(wargear.S),
      ap: this.parseAP(wargear.AP),
      damage: this.parseDice(wargear.D),
      type: this.parseWeaponType(wargear.type),
      abilities,
      autoHit,
    };
  }

  private parseWeaponAbilities(description: string): WeaponAbility[] {
    if (!description) return [];
    const abilities: WeaponAbility[] = [];
    const upper = description.toUpperCase();

    const patterns: Array<[RegExp, WeaponAbility]> = [
      [/\bSUSTAINED HITS 1\b/, WeaponAbility.SUSTAINED_1],
      [/\bSUSTAINED HITS 2\b/, WeaponAbility.SUSTAINED_2],
      [/\bSUSTAINED HITS 3\b/, WeaponAbility.SUSTAINED_3],
      [/\bLETHAL HITS\b/, WeaponAbility.LETHAL_HITS],
      [/\bDEVASTATING WOUNDS\b/, WeaponAbility.DEVASTATING_WOUNDS],
      [/\bTORRENT\b/, WeaponAbility.TORRENT],
      [/\bBLAST\b/, WeaponAbility.BLAST],
      [/\bHEAVY\b/, WeaponAbility.HEAVY],
      [/\bASSAULT\b/, WeaponAbility.ASSAULT],
      [/\bPISTOL\b/, WeaponAbility.PISTOL],
      [/\bRAPID FIRE\b/, WeaponAbility.RAPID_FIRE],
      [/\bANTI-INFANTRY\b/, WeaponAbility.ANTI_INFANTRY],
      [/\bANTI-VEHICLE\b/, WeaponAbility.ANTI_VEHICLE],
      [/\bANTI-MONSTER\b/, WeaponAbility.ANTI_MONSTER],
      [/\bIGNORES COVER\b/, WeaponAbility.IGNORES_COVER],
      [/\bTWINNED\b/, WeaponAbility.TWINNED],
      [/\bPSYCHIC\b/, WeaponAbility.PSYCHIC],
      [/\bMELTA\b/, WeaponAbility.MELTA],
      [/\bHAZARDOUS\b/, WeaponAbility.HAZARDOUS],
    ];

    for (const [pattern, ability] of patterns) {
      if (pattern.test(upper)) abilities.push(ability);
    }

    return abilities;
  }

  // =========================================================
  // === Стоимость
  // =========================================================

  private extractNumber(value: string): number | null {
    if (!value) return null;
    const m = value.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  private extractModelsFromDesc(desc: string): number | null {
    const m = desc.match(/(\d+)\s*models?/i);
    return m ? parseInt(m[1], 10) : null;
  }

  private parseCost(
    costs: WahapediaCost[],
    preferredModels: number | null
  ): { points: number; modelsCount: number } {
    const valid = costs
      .map((c) => ({
        desc: c.description,
        cost: this.extractNumber(c.cost),
        models: this.extractModelsFromDesc(c.description),
      }))
      .filter((c) => c.cost !== null && c.cost > 0);

    if (valid.length === 0) {
      console.warn(`⚠️ Нет валидной стоимости`, costs[0]);
      return { points: 0, modelsCount: 1 };
    }

    let chosen =
      preferredModels != null
        ? valid.find((v) => v.models === preferredModels)
        : undefined;

    if (!chosen) {
      chosen = valid.reduce((min, v) =>
        v.models !== null && (min.models === null || v.models < min.models) ? v : min
      );
    }

    return {
      points: chosen.cost!,
      modelsCount: chosen.models ?? preferredModels ?? 1,
    };
  }

  // =========================================================
  // === Универсальные парсеры
  // =========================================================

  private parseStat(value: string): number {
    if (!value || value === '-') return 0;
    const num = parseInt(value, 10);
    return isNaN(num) ? 0 : num;
  }

  private parseSaveStat(value: string): number | null {
    if (!value || value === '-') return null;
    const match = value.match(/(\d+)\+/);
    return match ? parseInt(match[1], 10) : null;
  }

  private parseSkill(value: string): number {
    if (!value) return 4;
    const plus = value.match(/(\d+)\+/);
    if (plus) return parseInt(plus[1], 10);
    const plain = value.match(/^(\d)$/);
    if (plain) return parseInt(plain[1], 10);
    return 4;
  }

  private parseAP(value: string): number {
    if (!value || value === '-') return 0;
    const num = parseInt(value, 10);
    return isNaN(num) ? 0 : num;
  }

  private parseMovement(value: string): number {
    const match = value.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 6;
  }

  private parseRange(value: string): number {
    if (!value) return 0;
    const lower = value.toLowerCase();
    if (lower === 'melee' || lower === '-') return 0;
    const match = value.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  private parseDice(value: string): DiceValue {
    if (!value || value === '-') return 1;
    const trimmed = value.trim().toUpperCase();
    if (trimmed === 'D6') return 'D6';
    if (trimmed === 'D3') return 'D3';
    const num = parseInt(value, 10);
    return isNaN(num) ? 1 : num;
  }

  private parseWeaponType(value: string): 'Melee' | 'Range' {
    return value.toLowerCase() === 'melee' ? 'Melee' : 'Range';
  }

  private hasKeyword(keywords: string[], keyword: string): boolean {
    return keywords.some((k) => k.toUpperCase() === keyword.toUpperCase());
  }

  // =========================================================
  // === Категории и роли
  // =========================================================

  private categorize(unit: Unit): UnitCategory {
    const kws = unit.keywords.map((k) => k.toUpperCase());

    if (kws.includes('TRANSPORT')) return UnitCategory.TRANSPORT;
    if (kws.includes('AIRCRAFT')) return UnitCategory.FLYER;
    if (kws.includes('MONSTER') || (unit.wounds >= 10 && unit.models === 1)) {
      return UnitCategory.MONSTER;
    }
    if (kws.includes('VEHICLE')) {
      if (unit.wounds >= 11 || unit.toughness >= 10) return UnitCategory.VEHICLE_HEAVY;
      return UnitCategory.VEHICLE_LIGHT;
    }
    if (
      kws.includes('CAVALRY') ||
      kws.includes('MOUNTED') ||
      kws.includes('BIKE') ||
      kws.includes('JETBIKE')
    ) {
      return UnitCategory.CAVALRY;
    }
    if (kws.includes('BEAST') || kws.includes('SWARM')) return UnitCategory.BEAST;
    if (kws.includes('INFANTRY')) {
      if (unit.models >= 10 && unit.pointsPerModel <= 12) return UnitCategory.HORDE;
      if (unit.pointsPerModel >= 25 || unit.invulnerableSave !== null) {
        return UnitCategory.ELITE;
      }
      return UnitCategory.INFANTRY;
    }

    return UnitCategory.INFANTRY;
  }

  private predictRole(unit: Unit): UnitRole {
    if (unit.category === UnitCategory.TRANSPORT) return UnitRole.TRANSPORT;
    if (unit.hasInfiltrate || unit.hasScout) return UnitRole.SCOUT;

    const avgDamagePerModel = this.averageDamage(unit);
    const ehpPerModel = this.roughEHP(unit) / Math.max(unit.models, 1);

    if (avgDamagePerModel > ehpPerModel * 1.5) return UnitRole.STRIKER;
    if (ehpPerModel > avgDamagePerModel * 2) return UnitRole.TANK;
    if (unit.objectiveControlTotal >= unit.models) return UnitRole.OBJECTIVE;

    return UnitRole.STRIKER;
  }

  private averageDamage(unit: Unit): number {
    let total = 0;
    for (const w of unit.weapons) {
      const attacks = typeof w.attacks === 'number' ? w.attacks : 3.5;
      const damage = typeof w.damage === 'number' ? w.damage : 3.5;
      const hitChance = w.autoHit ? 1 : (7 - w.skill) / 6;
      const woundChance = this.woundChance(w.strength, 4);
      total += attacks * hitChance * woundChance * damage;
    }
    return total;
  }

  private roughEHP(unit: Unit): number {
    let total = unit.woundsTotal;
    const save = unit.save ?? 7;
    total *= 6 / Math.max(1, 7 - save);
    if (unit.invulnerableSave) {
      const invulnMult = 6 / Math.max(1, 7 - unit.invulnerableSave);
      total = Math.max(total, unit.woundsTotal * invulnMult);
    }
    return total;
  }

  private woundChance(strength: number, toughness: number): number {
    if (strength >= toughness * 2) return 5 / 6;
    if (strength > toughness) return 4 / 6;
    if (strength === toughness) return 3 / 6;
    if (strength * 2 <= toughness) return 1 / 6;
    return 2 / 6;
  }
}

