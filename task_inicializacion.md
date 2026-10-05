Este repositorio va a guardar el código fuente de una aplicación que permita la gestión de una barbería.

El software en si va a ser una MVP.

Las funcionalidades basicas que deben cubrir son:
- Registro y lógin de una barberia (tenant)
- Cada barberia puede tener N administradores (que también son empleados)
- Cada barberia puede tener N empleados, cargados por el administrador
- Cada barbería puede tener N servicios, donde cada uno tiene su costo asociado
- Cada barbería puede tener N productos, donde cada uno tiene su costo asociado
- Cada empleado puede registrar que ofrecio servicios a un cliente
- Cada empleado puede registrar que vendió N productos a un cliente
- Los servicios y productos pueden registrarse al mismo tiempo
- Los administradores deben tener una visual de lo que está pasando en su barberia (ventas, servicios, actividades de los empleados)

Es importante el manejo de usuarios y poder dividir la información de cada barberia.

Cuando digo "barberia" tambien puede ser un salón de belleza, es simplemente mas corto.

El frontend debe mostrar el nombre de la barberia, un logo que haya cargado un administrador

Obligatoriamente debe ser una aplicación web, optimizado para dispositivos mobile. Mientras más simple sea la carga y visualización de datos, mejor.

La base de datos debe ser un SQL Lite. Tratar de hacerlo lo más abstraido posible para que el día de mañana pueda migrarse a MySQL/Postgress.

## Preguntas que me hizo la IA

> ¿Qué querés que entregue primero: una app funcional, un prototipo visual navegable o una propuesta de arquitectura?

Respuesta: MVP funcional de punta a punta

> ¿Cada empleado tendrá usuario y contraseña propios? ¿El registro de barberías será abierto o solo lo habilita un administrador? ¿Hace falta recuperación de contraseña?

Respuesta: Deberia haber dos registros: uno de usuarios y otro de barberias. Al registrar una barberia debe, obligatoriamente, elegir a un usuario como administrador de esa barberia (aunque puedan ser N).

> Al registrar operaciones, ¿hay que guardar cliente, cantidad, precio cobrado y empleado responsable? ¿Productos requieren control de stock? ¿Se permiten operaciones sin cliente identificado?

Respuesta: Si, guardar todo eso para despues poder hacer analiticas.
Por el momento no requiere control de stock.
Se permiten operaciones sin cliente identificado. L

> ¿Qué reportes concretos necesita el administrador? ¿Hay que poder anular/corregir operaciones o registrar pagos parciales y medios de pago?

Respuesta: Al principio saber cuanto servicios y productos se vendieron por dia , semana, mes. Quienes de sus empleados trabaja mas o menos y qué suelen pedir los clientes.

> ¿Tenés preferencias de tecnología, idioma/moneda, estilo visual o publicación? Si no, puedo elegir opciones simples y documentarlas.

Respuesta: Quiero que sea algo facil de desplegar, como nodejs. El idioma debe ser español, en pesos argentinos. El estilo visual decidilo vos, debe ser lo más limpio y fácil de usar posible.


