export class AppError extends Error {
  constructor(status,message,headers={}) { super(message); this.status=status; this.headers=headers; }
}

export const badRequest=message=>new AppError(400,message);
export const unauthorized=message=>new AppError(401,message);
export const forbidden=message=>new AppError(403,message);
export const notFound=message=>new AppError(404,message);
export const conflict=message=>new AppError(409,message);
