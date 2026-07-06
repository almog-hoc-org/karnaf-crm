import { describe, expect, it } from 'vitest';
import { fallbackTemplateParams, isTemplateConfigError } from './provider-errors';

describe('isTemplateConfigError', () => {
  it('matches #132000 param-count mismatch', () => {
    expect(
      isTemplateConfigError(
        '{"error":{"code":132000,"message":"Number of localizable_params (1) does not match the expected number of params (0)"}}',
      ),
    ).toBe(true);
  });

  it('matches #132001 template missing', () => {
    expect(isTemplateConfigError('error 132001')).toBe(true);
    expect(isTemplateConfigError('Template name does not exist in the translation')).toBe(true);
  });

  it('matches the generic param-mismatch phrasing', () => {
    expect(isTemplateConfigError('number of parameters does not match expected')).toBe(true);
  });

  it('ignores other provider errors and empties', () => {
    expect(isTemplateConfigError('(#131047) Re-engagement message')).toBe(false);
    expect(isTemplateConfigError('rate limited')).toBe(false);
    expect(isTemplateConfigError(null)).toBe(false);
    expect(isTemplateConfigError('')).toBe(false);
  });
});

describe('fallbackTemplateParams', () => {
  it('always exactly one param named reply', () => {
    expect(fallbackTemplateParams('שלום')).toEqual([{ name: 'reply', value: 'שלום' }]);
  });
});
