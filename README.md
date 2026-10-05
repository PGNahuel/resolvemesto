# Ritual · gestión para barberías y salones

MVP web para registrar servicios y productos, organizar el equipo y consultar la actividad del negocio. La interfaz está en español, muestra precios en pesos argentinos y se adapta a celulares.

## Requisitos y puesta en marcha

- Node.js 22.5 o superior (usa SQLite integrado en Node; no requiere instalar paquetes).
- Ejecutá `npm start` y abrí `http://localhost:8081`.
- Para desarrollo con reinicio automático: `npm run dev`.
- El puerto predeterminado es `8081`; podés cambiarlo con la variable `PORT`.

El servidor escribe logs JSON en la terminal. Cada solicitud API incluye un `request_id`, método, ruta, estado y duración; ante errores internos también registra el código y mensaje técnico. No registra contraseñas ni emails.

La base `barberia.sqlite` se crea automáticamente en el directorio del proyecto. Conservá ese archivo para guardar los datos y respaldalo periódicamente. En un despliegue, montá almacenamiento persistente para la base y mantené el proceso en una sola instancia.

## Primer uso

1. Creá una cuenta con nombre, email y contraseña.
2. Creá el espacio de tu barbería o salón. La cuenta que lo crea queda como administradora y empleada.
3. Cargá servicios y productos con sus precios.
4. Para sumar personas, primero deben crear su propia cuenta; luego un administrador las agrega por email y elige su rol.
5. Registrá una operación con uno o más ítems, el empleado responsable y, si se conoce, el nombre del cliente.

Una cuenta puede pertenecer a varios espacios. Los datos de cada espacio se consultan mediante su membresía. Las contraseñas se guardan con derivación criptográfica y la sesión se mantiene en una cookie HTTP-only.

## Incluye

- Registro e inicio/cierre de sesión.
- Espacios separados, administración y membresías de empleados.
- Catálogo de servicios y productos; retirar un ítem lo oculta de nuevas operaciones y conserva su historial.
- Tickets con varios ítems, cantidades, precio aplicado, empleado y cliente opcional.
- Panel de ingresos, servicios, productos, actividad por empleado, ítems más pedidos y operaciones recientes.
- Períodos de hoy, últimos 7 días y mes calendario actual.
- Nombre y logo del negocio.

El registro de productos no administra inventario. El MVP tampoco incluye pagos, anulaciones ni recuperación de contraseña.
