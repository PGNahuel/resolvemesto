# Resolvemesto · gestión para barberías y salones

MVP web para registrar servicios y productos, organizar el equipo y consultar la actividad del negocio. La interfaz está en español, muestra precios en pesos argentinos y se adapta a celulares.

## Requisitos y puesta en marcha

- Node.js 22.5 o superior (usa SQLite integrado en Node; no requiere instalar paquetes).
- Ejecutá `npm start` y abrí `http://localhost:8081`.
- Para desarrollo con reinicio automático: `npm run dev`.
- Para ejecutar la suite end-to-end: `npm test`.
- El puerto predeterminado es `8081`; podés cambiarlo con la variable `PORT`.

El servidor escribe logs JSON en la terminal. Cada solicitud API incluye un `request_id`, método, ruta, estado y duración; ante errores internos también registra el código y mensaje técnico. No registra contraseñas ni emails.

La base `resolvemesto.sqlite` se crea automáticamente en el directorio del proyecto. Si ya existe una base `barberia.sqlite`, la aplicación sigue usándola para conservar los datos. También podés indicar la ubicación con `DB_PATH`. Conservá ese archivo para guardar los datos y respaldalo periódicamente. En un despliegue, montá almacenamiento persistente para la base y mantené el proceso en una sola instancia.

## Primer uso

1. Creá una cuenta con nombre, email y contraseña.
2. Creá el espacio de tu barbería o salón. La cuenta que lo crea queda como administradora y empleada.
3. Cargá servicios y productos con sus precios.
4. Para sumar personas, primero deben crear su propia cuenta; luego un administrador las agrega por email y elige su rol.
5. Registrá una operación con uno o más ítems, el empleado responsable y, si se conoce, el nombre del cliente.

Una cuenta puede pertenecer a varios espacios. Los datos de cada espacio se consultan mediante su membresía y cada operación vuelve a validar permisos en el servidor. Las contraseñas se guardan con scrypt, el login limita intentos repetidos y un cambio de contraseña cierra todas las sesiones.

## Incluye

- Registro e inicio/cierre de sesión.
- Espacios separados, administración y membresías de empleados.
- Catálogo de servicios y productos; retirar un ítem lo oculta de nuevas operaciones y conserva su historial.
- Tickets con varios ítems, cantidades, precio aplicado, empleado y cliente opcional.
- Medio de pago, descuentos, notas y anulaciones que no eliminan el comprobante.
- Auditoría de cambios de ventas, catálogo, clientes, equipo y negocio.
- Panel de ingresos, servicios, productos, actividad por empleado, ítems más pedidos y operaciones recientes.
- Períodos de hoy, últimos 7 días y mes calendario actual.
- Nombre y logo del negocio.

Las ventas anuladas quedan fuera del tablero pero permanecen en el historial y la auditoría. Los precios ya cobrados no se reescriben al editar el catálogo.

El registro de productos no administra inventario. El MVP tampoco incluye procesamiento de pagos ni recuperación de contraseña por email.

## Seguridad y privacidad

- Los endpoints de administración rechazan a empleados aunque manipulen rutas, IDs o headers.
- Cada consulta valida que la membresía corresponda al negocio solicitado.
- Los empleados ven nombres y roles del equipo, pero no los emails de otras personas.
- Las cookies de sesión son HTTP-only y SameSite Strict; en producción también se marcan Secure.
- La API aplica headers defensivos, validación de origen y límites de tamaño.

La suite usa una base SQLite temporal y cubre alta de negocio, emails normalizados, usuario independiente y vinculación, permisos por rol, creación/edición/anulación de ventas, auditoría, rate limiting, invalidación de sesiones y aislamiento entre negocios.

## Arquitectura

El backend está separado por responsabilidad:

- `server.js`: composición de dependencias, headers HTTP, logging y ciclo de vida del proceso.
- `src/handler.js`: routing HTTP, lectura de requests, cookies y códigos de respuesta.
- `src/service.js`: validaciones, permisos, reglas de negocio y transacciones.
- `src/repository.js`: único punto de acceso SQL y mapeo de datos.
- `src/database.js`: creación y migraciones de SQLite.
- `src/security.js`: hashing de contraseñas y tokens de sesión.

El flujo de dependencias es unidireccional: `handler → service → repository`. El service y el repository no conocen objetos HTTP.
