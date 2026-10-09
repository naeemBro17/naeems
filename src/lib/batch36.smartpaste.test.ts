import { describe, expect, it } from 'vitest';
import { BD_DISTRICTS, BD_THANAS } from '../data/bangladeshGeo';
import {
  banglishKey,
  jaroWinkler,
  normalizeBdPhone,
  parseOrderMessage,
  tidyAddress,
  toAsciiDigits,
  type ThanaOption,
} from './smartPaste';

// Batch 36 Part 3: the Smart paste parser, against the real thana list
// bundled with the site.

const districtName = new Map(BD_DISTRICTS.map((d) => [d.id, d.name]));
const THANAS: ThanaOption[] = BD_THANAS.map((t) => ({ name: t.name, district: districtName.get(t.districtId) ?? '', bnName: t.bnName }));
const DISTRICTS = BD_DISTRICTS.map((d) => ({ name: d.name, bnName: d.bnName }));

const parse = (text: string) => parseOrderMessage(text, THANAS, DISTRICTS);

describe('the approved example', () => {
  it('Rume / poroshuram / Feni → Parshuram, Feni; address in the customer’s own words', () => {
    const r = parse('Rume\nYousuf traders dhan dokaner pisone basha,uttar bazar,poroshuram, Feni\n01638820872');
    expect(r.name).toBe('Rume');
    expect(r.phone).toBe('01638820872');
    expect(r.thana).toEqual(expect.objectContaining({ name: 'Parshuram', district: 'Feni' }));
    expect(r.district).toBe('Feni');
    expect(r.thanaMatchedText).toBe('poroshuram');
    expect(r.address).toBe('Yousuf traders dhan dokaner pisone basha, uttar bazar, poroshuram, Feni');
    expect(r.thanaChoices.map((c) => c.name)).toContain('Parshuram');
    expect(r.thanaChoices).toHaveLength(3);
  });
});

describe('phones', () => {
  it.each([
    ['01638820872', '01638820872'],
    ['+8801638820872', '01638820872'],
    ['8801638820872', '01638820872'],
    ['+88 01638-820872', '01638820872'],
    ['01638 820 872', '01638820872'],
    ['01638.820.872', '01638820872'],
    ['০১৬৩৮৮২০৮৭২', '01638820872'],
    ['০১৬৩৮-৮২০৮৭২', '01638820872'],
  ])('%s → %s', (written, phone) => {
    expect(parse(`Karim\n${written}\nMirpur 10, Dhaka`).phone).toBe(phone);
  });

  it('a second number becomes the alternative phone; the same number twice is one', () => {
    const r = parse('Nasrin\n01711-223344 / 01911223355\nDhanmondi 27, Dhaka');
    expect(r.phone).toBe('01711223344');
    expect(r.altPhone).toBe('01911223355');
    expect(parse('Nasrin 01711223344 01711 223344\nDhanmondi').altPhone).toBeNull();
  });

  it('landlines and short numbers are not mobiles', () => {
    expect(normalizeBdPhone('02-9123456')).toBeNull();
    expect(normalizeBdPhone('0123456789')).toBeNull();
    expect(normalizeBdPhone('01238820872')).toBeNull();
  });

  it('Bengali digits', () => {
    expect(toAsciiDigits('বাসা ১২, রোড ৫')).toBe('বাসা 12, রোড 5');
  });
});

describe('names', () => {
  it('a "Name:" label wins, kept as written', () => {
    const r = parse('Address: House 12, Road 5, Dhanmondi, Dhaka\nName: mst. Rokeya begum\nPhone: 01812345678');
    expect(r.name).toBe('mst. Rokeya begum');
    expect(r.address).toBe('House 12, Road 5, Dhanmondi, Dhaka');
    expect(r.thana?.name).toBe('Dhanmondi');
  });

  it('first line without digits that is not an address', () => {
    expect(parse('Sumaiya Akter\nSector 7, Uttara, Dhaka\n01755667788').name).toBe('Sumaiya Akter');
  });

  it('no name in the message → none guessed', () => {
    const r = parse('Dhanmondi 15, Dhaka\n01755667788');
    expect(r.name).toBeNull();
    expect(r.address).toBe('Dhanmondi 15, Dhaka');
  });

  it('a place name alone on the first line is not taken as the name', () => {
    const r = parse('Feni\nRahim\n01811000111');
    expect(r.name).toBe('Rahim');
  });

  it('Bengali name and address', () => {
    const r = parse('নাম: রুমা আক্তার\nঠিকানা: উত্তর বাজার, পরশুরাম, ফেনী\nমোবাইল: ০১৬৩৮৮২০৮৭২');
    expect(r.name).toBe('রুমা আক্তার');
    expect(r.phone).toBe('01638820872');
    expect(r.thana?.name).toBe('Parshuram');
    expect(r.address).toBe('উত্তর বাজার, পরশুরাম, ফেনী');
  });
});

describe('thanas: Banglish spellings, misspellings, districts', () => {
  it.each([
    ['Rafiq\nCollege road, sonagazi, feni\n01712000000', 'Sonagazi', 'Feni'],
    ['Rafiq\nfulgaji bazar, Feni\n01712000000', 'Fulgazi', 'Feni'],
    ['Rafiq\nchagolnaiya, feni\n01712000000', 'Chhagalnaiya', 'Feni'],
    ['Rafiq\ndagonbhuiya, feni\n01712000000', 'Daganbhuiyan', 'Feni'],
    ['Lima\nHouse 4, road 2, Dhanmondi, Dhaka\n01712000000', 'Dhanmondi', 'Dhaka'],
    ['Lima\nshahbag, dhaka\n01712000000', 'Shahbag', 'Dhaka'],
    ['Lima\nmohammadpur, dhaka\n01712000000', 'Mohammadpur', 'Dhaka'],
    ['Lima\nmohamadpur dhaka\n01712000000', 'Mohammadpur', 'Dhaka'],
    ['Lima\nbadda, dhaka\n01712000000', 'Badda', 'Dhaka'],
    ['Lima\nsavar\n01712000000', 'Savar', 'Dhaka'],
    ['Lima\nKotwali, Chattogram\n01712000000', 'Kotwali', 'Chattogram'],
    ['Lima\nsitakundo, chittagong\n01712000000', 'Sitakunda', 'Chattogram'],
    ['Lima\nbegumgonj, noakhali\n01712000000', 'Begumganj', 'Noakhali'],
  ])('%s', (message, thana, district) => {
    const r = parse(message);
    expect(r.thana, JSON.stringify(r.thanaChoices)).toEqual(expect.objectContaining({ name: thana, district }));
  });

  it('Mirpur, Dhaka → Dhaka’s Mirpur, not Kushtia’s', () => {
    const r = parse('Karim\nMirpur 10, Dhaka\n01712000000');
    expect(r.thana?.district).toBe('Dhaka');
    expect(r.thana?.name).toMatch(/^Mirpur/);
  });

  it('Mirpur with no district → not guessed; both offered as chips', () => {
    const r = parse('Karim\nMirpur\n01712000000');
    expect(r.thana).toBeNull();
    const districts = r.thanaChoices.filter((c) => c.name.startsWith('Mirpur')).map((c) => c.district);
    expect(districts).toEqual(expect.arrayContaining(['Dhaka', 'Kushtia']));
  });

  it('Uttara → East or West: chips, nothing preselected', () => {
    const r = parse('Sumaiya\nSector 7, Uttara, Dhaka\n01755667788');
    expect(r.thana).toBeNull();
    expect(r.thanaChoices.map((c) => c.name)).toEqual(expect.arrayContaining(['Uttara East', 'Uttara West']));
  });

  it('district only → no thana, but that district’s thanas as chips (Sadar first)', () => {
    const r = parse('Rafiq\nstation road, Feni\n01712000000');
    expect(r.thana).toBeNull();
    expect(r.district).toBe('Feni');
    expect(r.thanaChoices[0].name).toBe('Feni Sadar');
    expect(r.thanaChoices.every((c) => c.district === 'Feni')).toBe(true);
  });

  it('nothing recognisable → no thana, no crash', () => {
    const r = parse('hello\n01712000000');
    expect(r.thana).toBeNull();
    expect(r.phone).toBe('01712000000');
  });

  it('a "Thana:" label is used', () => {
    const r = parse('Name: Joy\nThana: Poroshuram\nAddress: uttar bazar\n01712000000');
    expect(r.thana?.name).toBe('Parshuram');
  });
});

describe('address, labels and hints', () => {
  it('never translated or reworded — only spaces and commas tidied', () => {
    expect(tidyAddress('  dhan dokaner   pisone basha ,uttar bazar,,  ')).toBe('dhan dokaner pisone basha, uttar bazar');
    const r = parse('Rume\nবাড়ির পাশে মসজিদ,  uttar bazar ,poroshuram\n01638820872');
    expect(r.address).toBe('বাড়ির পাশে মসজিদ, uttar bazar, poroshuram');
  });

  it('COD and Product are hints only', () => {
    const r = parse('Name: Tania\nPhone: 01812345678\nAddress: Gulshan 2, Dhaka\nCOD: 1250 tk\nProduct: Scalpe Plus x2');
    expect(r.codHint).toBe('1250 tk');
    expect(r.productHint).toBe('Scalpe Plus x2');
    expect(r.address).toBe('Gulshan 2, Dhaka');
    expect(r.address).not.toMatch(/1250|Scalpe/);
  });

  it('everything on one line', () => {
    const r = parse('Rume, Yousuf traders, uttar bazar, poroshuram, Feni, 01638820872');
    expect(r.phone).toBe('01638820872');
    expect(r.thana?.name).toBe('Parshuram');
  });

  it('a WhatsApp-style message with a greeting line', () => {
    const r = parse('Assalamu alaikum\nName: Habib\nMobile: +88 01999-888777\nAddress: Bashundhara R/A, Block C, Dhaka');
    expect(r.name).toBe('Habib');
    expect(r.phone).toBe('01999888777');
  });
});

describe('spelling helpers', () => {
  it('Banglish keys line up', () => {
    expect(banglishKey('Poroshuram')).toBe(banglishKey('Porashuram'));
    expect(banglishKey('Begumgonj')).toBe(banglishKey('Begumganj'));
    expect(jaroWinkler(banglishKey('poroshuram'), banglishKey('Parshuram'))).toBeGreaterThan(0.9);
  });
});
