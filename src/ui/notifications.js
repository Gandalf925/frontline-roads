export class Notifications {
  constructor(element, { i18n = null } = {}) {
    this.element = element;
    this.i18n = i18n;
    this.timer = null;
    this.currentSource = null;
    this.currentMessage = '';
    this.currentMessageLocalized = false;
  }

  localize(message) {
    return this.i18n?.status?.(message) ?? this.i18n?.copy?.(message) ?? String(message ?? '');
  }

  normalizeSource(message, { localized = false } = {}) {
    if (message && typeof message === 'object' && message.key) {
      return {
        key: String(message.key),
        params: message.params ?? {},
        fallback: message.text ?? message.fallback ?? '',
        localized: false
      };
    }
    if (message && typeof message === 'object' && Object.hasOwn(message, 'text')) {
      return {
        text: String(message.text ?? ''),
        localized: Boolean(localized || message.localized)
      };
    }
    return {
      text: String(message ?? ''),
      localized: Boolean(localized)
    };
  }

  renderSource(source) {
    if (!source) return '';
    if (source.key) {
      return this.i18n?.message?.(source.key, source.params ?? {}, source.fallback ?? '')
        ?? this.localize(source.fallback || source.key);
    }
    return source.localized ? source.text : this.localize(source.text);
  }

  show(message, duration = 2600, { localized = false } = {}) {
    clearTimeout(this.timer);
    this.currentSource = this.normalizeSource(message, { localized });
    this.currentMessage = this.renderSource(this.currentSource);
    this.currentMessageLocalized = Boolean(this.currentSource?.localized || this.currentSource?.key);
    this.element.textContent = this.currentMessage;
    this.element.classList.add('is-visible');
    this.timer = setTimeout(() => this.element.classList.remove('is-visible'), duration);
  }

  refreshLocalization() {
    if (this.currentSource && this.element.classList.contains('is-visible')) {
      this.currentMessage = this.renderSource(this.currentSource);
      this.element.textContent = this.currentMessage;
    }
  }
}
