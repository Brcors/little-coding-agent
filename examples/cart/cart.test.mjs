import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from './cart.mjs';

test('empty cart returns zero', () => assert.equal(total([]), 0));
test('sums price times quantity', () => assert.equal(total([{ price: 5, quantity: 2 }, { price: 3, quantity: 1 }]), 13));
