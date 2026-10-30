// Solo registra categorías y códigos: nunca la URI, credenciales ni mensajes del driver.
export function mongoDiagnostic(uri: string, error: unknown) {
  const target = /^mongodb\+srv:/i.test(uri) ? 'atlas-srv'
    : /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1|\[::1\])(?=[:,/]|$)/i.test(uri) ? 'local' : 'remote';
  const codes = new Set<string>();
  const types = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return;
    seen.add(value);
    const item = value as Record<string, unknown>;
    if (typeof item.code === 'number') codes.add(String(item.code));
    if (typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(item.code)) codes.add(item.code);
    if (typeof item.name === 'string' && /^(?:Mongo[A-Za-z]+Error|Error|AggregateError)$/.test(item.name)) types.add(item.name);
    visit(item.cause, depth + 1);
    visit(item.reason, depth + 1);
    visit(item.error, depth + 1);
    if (item.servers instanceof Map) for (const server of item.servers.values()) visit(server, depth + 1);
    if (Array.isArray(item.errors)) for (const nested of item.errors) visit(nested, depth + 1);
  };
  visit(error);
  const hint = target === 'local' ? 'MONGODB_URI apunta a localhost. En Vercel configura la URI de Atlas.'
    : codes.has('18') ? 'MongoDB rechazó la autenticación. Revisa el usuario de base de datos y su contraseña.'
    : codes.has('ENOTFOUND') || codes.has('EAI_AGAIN') ? 'No se pudo resolver el host. Revisa el nombre del clúster, DNS y que Atlas esté activo.'
    : 'Revisa Network Access en Atlas para la red de salida de Vercel, el estado del clúster y los códigos de conexión.';
  return { target, codes: [...codes], types: [...types], hint };
}
