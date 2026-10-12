#!/usr/bin/env node
/* Layout stress build: renders the site with synthetic, deliberately awkward content
   (very long titles, names, affiliations and abstracts in both alphabets, missing photos,
   fallback languages) into dist-stress/, which is never deployed. The strings are
   generated here and are not academic content. Usage: node tools/stress.mjs */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rep = (s, n) => Array.from({ length: n }, (_, i) => s.replace('#', i + 1)).join(' ');
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

const talks = [
  { number: 999, slug: 'stress-long-title', date: day(9), time: '17:00', language: 'en',
    speaker: 'Layout-Test Speaker With An Unusually Long Compound Family-Name-That-Wraps',
    affiliation: 'Layout Test Faculty of a University Whose Official Name Runs to Fourteen Words and a Comma, Somewhere',
    title: { en: 'Layout test: an extremely long academic-style title that keeps going past the point where any reasonable title would have stopped, with a subtitle and a parenthesis (test)', ru: 'Тест вёрстки: чрезвычайно длинный заголовок в академическом стиле, который продолжается гораздо дальше, чем любой разумный заголовок, с подзаголовком и скобкой (тест)' },
    abstract: { en: rep('Layout test sentence number # is here to check the measure, the leading and the paragraph spacing of long reading text.', 14) + '\n\n' + rep('Second paragraph sentence # continues the check.', 8), ru: rep('Тестовое предложение номер # проверяет ширину колонки, интерлиньяж и расстояние между абзацами.', 14) + '\n\n' + rep('Второй абзац, предложение #, продолжает проверку.', 8) },
    bio: { en: rep('Biography test sentence #.', 10) }, join: true, recording: false, slides: '' },
  { number: 998, slug: 'stress-ru-only', date: day(16), time: '17:00', language: 'ru',
    speaker: { ru: 'Тестовый Докладчик С Очень Длинной Двойной Фамилией-Которая-Переносится' },
    affiliation: { ru: 'Тестовая кафедра тестового университета с очень длинным официальным названием из тринадцати слов' },
    title: { ru: 'Тест вёрстки: только русский заголовок без английского перевода, чтобы проверить подстановку языка и атрибут lang' },
    abstract: { ru: rep('Абзац на русском, предложение #, без английской версии.', 12) }, bio: { ru: rep('Биография, предложение #.', 6) },
    join: false, recording: false, slides: '' },
  { number: 997, slug: 'stress-unbreakable', date: day(23), time: '09:30', language: 'en',
    speaker: 'Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    affiliation: 'Unbreakable-affiliation-string-without-any-spaces-to-test-overflow-wrap-on-narrow-screens',
    title: { en: 'Unbreakablewordunbreakablewordunbreakablewordunbreakablewordunbreakableword and then normal words' },
    abstract: { en: 'Short abstract.' }, bio: { en: 'Short bio.' }, join: true, recording: false, slides: '' },
  { number: 996, slug: 'stress-past-long', date: day(-6), time: '17:00', language: 'en',
    speaker: 'Layout-Test Past Speaker', affiliation: 'Layout Test Institute',
    title: { en: 'Layout test of a past session with a recording and slides and a title of moderate length that still wraps twice', ru: 'Тест вёрстки прошедшей сессии с записью и слайдами и заголовком умеренной длины, который всё же переносится дважды' },
    abstract: { en: rep('Past abstract sentence #.', 10), ru: rep('Абзац прошедшей сессии, предложение #.', 10) }, bio: { en: rep('Bio #.', 5) },
    join: false, recording: true, slides: 'https://example.org/slides.pdf', minutes: 'https://example.org/minutes.pdf' },
  { number: 995, slug: 'stress-past-short', date: day(-13), time: '17:00', language: 'ru',
    speaker: 'T. Short', affiliation: 'LTI', title: { en: 'Short', ru: 'Кратко' }, abstract: { en: 'One line.' }, bio: {},
    join: false, recording: true, slides: '' },
  { number: 994, slug: 'stress-last-year', date: `${new Date().getFullYear() - 1}-11-20`, time: '17:00', language: 'en',
    speaker: 'Layout-Test Speaker Last Year', affiliation: 'Layout Test Institute',
    title: { en: 'Layout test: a session from the previous year, to check the year grouping in the archive' },
    abstract: { en: 'Archive grouping check.' }, bio: {}, join: false, recording: false, slides: '' }
];

const dir = mkdtempSync(join(tmpdir(), 'afflux-stress-'));
const file = join(dir, 'talks.json');
writeFileSync(file, JSON.stringify({ talks }, null, 2));
const r = spawnSync(process.execPath, [join(ROOT, 'build.mjs'), '--talks', file, '--out', join(ROOT, 'dist-stress')], { stdio: 'inherit' });
process.exit(r.status);
