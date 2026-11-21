import { createElement } from 'react';
import { add } from '@sample/core';

export const Total = () => createElement('span', null, String(add(1, 1)));
