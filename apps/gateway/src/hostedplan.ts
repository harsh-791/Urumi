const IMAGE = /^[a-z0-9](?:[a-z0-9._/-]{0,180}[a-z0-9])?(?::[A-Za-z0-9._-]{1,128}|@[A-Za-z0-9:_+-]{8,200})$/;

export function validImage(image: string): boolean {
  return image.length <= 200 && !image.includes("://") && !/\s/.test(image) && IMAGE.test(image);
}

export function hostedName(slug: string): string {
  return `hosted-${slug}`;
}

export function hostedUrl(slug: string, namespace: string): string {
  return `http://${hostedName(slug)}.${namespace}.svc.cluster.local:8080/mcp`;
}
