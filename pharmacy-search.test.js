import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPharmacySearchQueries, buildPharmacySearchAnswer } from './pharmacy-search.js';

test('pharmacy search builds city-scoped queries including phone and address',()=>{
  const queries=buildPharmacySearchQueries('בית שמש');
  assert.equal(queries.length,4);
  assert.ok(queries.some(q=>q.includes('בית שמש')&&q.includes('טלפון')));
});

test('pharmacy answer lists only returned source results and extracts phone numbers',()=>{
  const answer=buildPharmacySearchAnswer({city:'בית שמש',results:[
    {title:'בית מרקחת א',url:'https://example.com/a',snippet:'כתובת רחוב הרקפת 36, טלפון 02-9906553'},
    {title:'בית מרקחת ב',url:'https://example.com/b',snippet:'טלפון 02-9914393'}
  ]});
  assert.match(answer,/בית מרקחת א/);
  assert.match(answer,/02-9906553/);
  assert.match(answer,/02-9914393/);
  assert.doesNotMatch(answer,/בית מרקחת ג/);
});

test('pharmacy answer never invents results when search is empty',()=>{
  const answer=buildPharmacySearchAnswer({city:'בית שמש',results:[]});
  assert.match(answer,/לא הצלחתי לאמת/);
  assert.doesNotMatch(answer,/02-1234567/);
});
