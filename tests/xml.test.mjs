import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, XmlParseError, decodeEntities } from '../src/host/xml.js';

test('entity declarations are rejected, a bare DOCTYPE is stripped', () => {
  // XXE guard: the entity vector is refused outright.
  assert.throws(() => parseXml('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "y">]><r/>'), XmlParseError);
  // A DOCTYPE carrying no entities is common in real feeds — parse it.
  const doc = parseXml('<!DOCTYPE html><html><body><p>x</p></body></html>');
  assert.equal(doc.children[0].name, 'html');
});

test('parses namespaced tags and CDATA, keeps local names', () => {
  const doc = parseXml('<rss><channel><item><title><![CDATA[A & B]]></title>' +
    '<content:encoded><![CDATA[<p>x</p>]]></content:encoded></item></channel></rss>');
  const item = doc.children[0].children[0].children[0];
  assert.equal(item.local, 'item');
  const encoded = item.children.find((node) => node.local === 'encoded');
  assert.equal(encoded.text, '<p>x</p>');
  assert.equal(item.children[0].text, 'A & B');
});

test('numeric entities decode, unknown pass through', () => {
  assert.equal(decodeEntities('&#20013;&#x6587;'), '中文');
  assert.equal(decodeEntities('&bogus;'), '&bogus;');
});

test('malformed XML throws XmlParseError', () => {
  assert.throws(() => parseXml('<unclosed><tag'), XmlParseError);
  assert.throws(() => parseXml('<a'), XmlParseError);
});
