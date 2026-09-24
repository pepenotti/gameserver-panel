SandboxVars = {
    VERSION = 6,
    -- Cambiando esto se establece la opción avanzada \Multiplicador de Población\. Por defecto=Normal
    -- 1 = Zombicidio
    -- 2 = Muy alto
    -- 3 = Alto
    -- 4 = Normal
    -- 5 = Bajo
    -- 6 = Nada
    Zombies = 4,
    -- Cómo se distribuyen los zombis en el mapa. Por defecto=Enfoque urbano
    -- 1 = Enfoque urbano
    -- 2 = Uniforme
    Distribution = 1,
    -- Controla si se aplica cierta aleatoriedad a la distribución de los zombis.
    ZombieVoronoiNoise = true,
    -- La frecuencia con la que se añaden nuevos zombis al mundo. Por defecto=Ninguno
    -- 1 = Alto
    -- 2 = Normal
    -- 3 = Bajo
    -- 4 = Ninguno
    ZombieRespawn = 4,
    -- Permitir que los zombis migren a celdas vacías.
    ZombieMigrate = true,
    -- Por defecto=1 Hora, 30 Minutos
    -- 1 = 15 Minutos
    -- 2 = 30 Minutos
    -- 3 = 1 Hora
    -- 4 = 1 Hora, 30 Minutos
    -- 5 = 2 Horas
    -- 6 = 3 Horas
    -- 7 = 4 Horas
    -- 8 = 5 Horas
    -- 9 = 6 Horas
    -- 10 = 7 Horas
    -- 11 = 8 Horas
    -- 12 = 9 Horas
    -- 13 = 10 Horas
    -- 14 = 11 Horas
    -- 15 = 12 Horas
    -- 16 = 13 Horas
    -- 17 = 14 Horas
    -- 18 = 15 Horas
    -- 19 = 16 Horas
    -- 20 = 17 Horas
    -- 21 = 18 Horas
    -- 22 = 19 Horas
    -- 23 = 20 Horas
    -- 24 = 21 Horas
    -- 25 = 22 Horas
    -- 26 = 23 Horas
    -- 27 = Tiempo real
    DayLength = 4,
    StartYear = 1,
    -- Mes en el que comienza el juego. Por defecto=Julio
    -- 1 = Enero
    -- 2 = Febrero
    -- 3 = Marzo
    -- 4 = Abril
    -- 5 = Mayo
    -- 6 = Junio
    -- 7 = Julio
    -- 8 = Agosto
    -- 9 = Septiembre
    -- 10 = Octubre
    -- 11 = Noviembre
    -- 12 = Diciembre
    StartMonth = 7,
    -- Día del mes en el que comienza el juego.
    StartDay = 9,
    -- Hora del día en la que comienza el juego. Por defecto=9 AM
    -- 1 = 7 AM
    -- 2 = 9 AM
    -- 3 = 12 PM
    -- 4 = 2 PM
    -- 5 = 5 PM
    -- 6 = 9 PM
    -- 7 = 12 AM
    -- 8 = 2 AM
    -- 9 = 5 AM
    StartTime = 2,
    -- Determina si la hora del día cambia de forma natural o si siempre es de día/noche. Por defecto=Normal
    -- 1 = Normal
    -- 2 = Día Infinito
    -- 3 = Noche Infinita
    DayNightCycle = 1,
    -- Determina si el clima cambia o permanece en un solo estado. Por defecto=Normal
    -- 1 = Normal
    -- 2 = Sin Clima
    -- 3 = Lluvia Infinita
    -- 4 = Tormenta Infinita
    -- 5 = Nieve Infinita
    -- 6 = Ventisca Infinita
    ClimateCycle = 1,
    -- Determina si la niebla aparece de forma natural, nunca aparece o siempre está presente. Por defecto=Normal
    -- 1 = Normal
    -- 2 = Sin Niebla
    -- 3 = Niebla Infinita
    FogCycle = 1,
    -- Tiempo después de la fecha de inicio predeterminada (9 de julio de 1993) en que los grifos dejan de ser fuentes infinitas de agua. Por defecto=0 - 30 días
    -- 1 = Instantáneo
    -- 2 = 0 - 30 días
    -- 3 = 0 - 2 meses
    -- 4 = 0 - 6 meses
    -- 5 = 0 - 1 año
    -- 6 = 0 - 5 años
    -- 7 = 2 - 6 meses
    -- 8 = 6 - 12 meses
    -- 9 = Desactivado
    WaterShut = 2,
    -- Tiempo después de la fecha de inicio predeterminada (9 de julio de 1993) en que la electricidad mundial se corta de forma permanente. Por defecto=14 - 30 días
    -- 1 = Instantáneo
    -- 2 = 14 - 30 días
    -- 3 = 14 días - 2 meses
    -- 4 = 14 días - 6 meses
    -- 5 = 14 días - 1 año
    -- 6 = 14 días - 5 años
    -- 7 = 2 - 6 meses
    -- 8 = 6 - 12 meses
    -- 9 = Desactivado
    ElecShut = 2,
    -- Cuánto tiempo duran las baterías de alarma después de que se corta la electricidad. Por defecto=0 - 30 días
    -- 1 = Instantáneo
    -- 2 = 0 - 30 días
    -- 3 = 0 - 2 meses
    -- 4 = 0 - 6 meses
    -- 5 = 0 - 1 año
    -- 6 = 0 - 5 años
    AlarmDecay = 2,
    -- Tiempo después de la fecha de inicio predeterminada (9 de julio de 1993) en que los grifos dejan de ser fuentes infinitas de agua. Mínimo=-1 Máximo=2147483647 Por defecto=14
    WaterShutModifier = 14,
    -- Tiempo después de la fecha de inicio predeterminada (9 de julio de 1993) en que la electricidad mundial se corta de forma permanente. Mínimo=-1 Máximo=2147483647 Por defecto=14
    ElecShutModifier = 14,
    -- Cuánto tiempo duran las baterías de alarma después de que se corta la electricidad. Mínimo=-1 Máximo=2147483647 Por defecto=14
    AlarmDecayModifier = 14,
    -- Cualquier alimento que pueda pudrirse o estropearse. Mínimo=0.00 Máximo=4.00 Por defecto=0.80
    FoodLootNew = 0.8,
    -- Todos los objetos que se pueden leer, incluidos folletos. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    LiteratureLootNew = 0.6,
    -- Libros que proporcionan multiplicadores de XP para habilidades. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    SkillBookLoot = 0.6,
    -- Objetos que enseñan recetas. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    RecipeResourceLoot = 0.6,
    -- Medicinas, vendajes y herramientas de primeros auxilios. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    MedicalLootNew = 0.6,
    -- Cañas de pescar, tiendas de campaña, equipo de camping, etc. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    SurvivalGearsLootNew = 0.6,
    -- Comida enlatada y deshidratada, bebidas. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    CannedFoodLootNew = 0.6,
    -- Armas que no son herramientas de otras categorías. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    WeaponLootNew = 0.6,
    -- Incluye accesorios para armas. Mínimo=0.00 Máximo=4.00 Por defecto=1.20
    RangedWeaponLootNew = 1.2,
    -- Munición suelta, cajas y cargadores. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    AmmoLootNew = 0.6,
    -- Piezas de vehículos y las herramientas necesarias para instalarlas. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    MechanicsLootNew = 0.6,
    -- Todo lo demás. También afecta la búsqueda de objetos en zonas de ciudad/carretera. Mínimo=0.00 Máximo=4.00 Por defecto=0.80
    OtherLootNew = 0.8,
    -- Todas las prendas que no son contenedores. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    ClothingLootNew = 0.6,
    -- Mochilas y otros contenedores portátiles, como maletas. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    ContainerLootNew = 0.6,
    -- Llaves de edificios/autos, llaveros y cerraduras. Mínimo=0.00 Máximo=4.00 Por defecto=0.40
    KeyLootNew = 0.4,
    -- Cintas VHS y CD. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    MediaLootNew = 0.6,
    -- Objetos de Spiffo, peluches y otros objetos coleccionables, como fotos. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    MementoLootNew = 0.6,
    -- Artículos utilizados en la cocina, incluidos aquellos (como cuchillos) que también pueden ser armas. No incluye comida. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    CookwareLootNew = 0.6,
    -- Artículos y armas que se utilizan como ingredientes para fabricar o construir. Esta categoría general no incluye objetos de otras categorías como utensilios de cocina o médicos. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    MaterialLootNew = 0.6,
    -- Artículos y herramientas utilizadas tanto para la agricultura animal como vegetal, como semillas, palas o azadas. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    FarmingLootNew = 0.6,
    -- Artículos y armas que son herramientas, pero no encajan en otras categorías como Mecánica o Agricultura. Mínimo=0.00 Máximo=4.00 Por defecto=0.60
    ToolLootNew = 0.6,
    -- <BHC> [!] Se recomienda que NO cambies esto. [!] <RGB:1,1,1>   Puede usarse para ajustar el número de tiradas realizadas en las tablas de botín al generar objetos. No reducirá el número de tiradas por debajo de 1. Puede afectar negativamente al rendimiento si se configura con valores altos. Se recomienda encarecidamente no cambiarlo. Mínimo=0.10 Máximo=100.00 Por defecto=1.00
    RollsMultiplier = 1.0,
    -- Lista separada por comas de tipos de objetos que no aparecerán como botín ordinario.
    LootItemRemovalList = "",
    -- Si está habilitado, los objetos en la lista de eliminación de botín o aquellos con rareza configurada como 'Ninguno' no aparecerán en historias aleatorias del mundo.
    RemoveStoryLoot = false,
    -- Si está habilitado, los objetos en la lista de eliminación de botín o aquellos con rareza configurada como 'Ninguno' no aparecerán como equipamiento de zombis.
    RemoveZombieLoot = false,
    -- Si es mayor que 0, la generación de botín aumenta en relación con el número de zombis cercanos, con el efecto multiplicado por este número. Mínimo=0 Máximo=20 Por defecto=0
    ZombiePopLootEffect = 0,
    -- Mínimo=0.00 Máximo=0.20 Por defecto=0.05
    InsaneLootFactor = 0.05,
    -- Mínimo=0.05 Máximo=0.60 Por defecto=0.20
    ExtremeLootFactor = 0.2,
    -- Mínimo=0.20 Máximo=1.00 Por defecto=0.60
    RareLootFactor = 0.6,
    -- Mínimo=0.60 Máximo=2.00 Por defecto=1.00
    NormalLootFactor = 1.0,
    -- Mínimo=1.00 Máximo=3.00 Por defecto=2.00
    CommonLootFactor = 2.0,
    -- Mínimo=2.00 Máximo=4.00 Por defecto=3.00
    AbundantLootFactor = 3.0,
    -- Controla la temperatura global. Por defecto=Normal
    -- 1 = Mucho frío
    -- 2 = Frío
    -- 3 = Normal
    -- 4 = Calor
    -- 5 = Mucho calor
    Temperature = 3,
    -- Controla la frecuencia de las lluvias. Por defecto=Normal
    -- 1 = Muy seco
    -- 2 = Seco
    -- 3 = Normal
    -- 4 = Lluvioso
    -- 5 = Muy lluvioso
    Rain = 3,
    -- Número de días hasta el 100% de crecimiento. Por defecto=Lento (200 días)
    -- 1 = Muy rápido (20 días)
    -- 2 = Rápido (50 días)
    -- 3 = Normal (100 días)
    -- 4 = Lento (200 días)
    -- 5 = Muy lento (500 días)
    ErosionSpeed = 4,
    -- Número de días hasta el 100% de expansión. -1 significa que no hay incremento. Cero usará la opción de velocidad de erosión. Máximo 36.500 (100 años). Mínimo=-1 Máximo=36500 Por defecto=0
    ErosionDays = 0,
    -- Controla la velocidad de crecimiento de las plantas. Por defecto=Normal
    -- 1 = Muy rápido
    -- 2 = Rápido
    -- 3 = Normal
    -- 4 = Lento
    -- 5 = Muy lento
    Farming = 3,
    -- Controla el tiempo que tardan los alimentos en descomponerse en un compostador. Por defecto=2 Semanas
    -- 1 = 1 Semana
    -- 2 = 2 Semanas
    -- 3 = 3 Semanas
    -- 4 = 4 Semanas
    -- 5 = 6 Semanas
    -- 6 = 8 Semanas
    -- 7 = 10 Semanas
    -- 8 = 12 Semanas
    CompostTime = 2,
    -- La rapidez con que disminuyen el hambre, la sed y el cansancio del personaje. Por defecto=Normal
    -- 1 = Muy rápido
    -- 2 = Rápido
    -- 3 = Normal
    -- 4 = Lento
    -- 5 = Muy lento
    StatsDecrease = 3,
    -- Controla la abundancia de peces y en general al rebuscar. Por defecto=Normal
    -- 1 = Muy pobre
    -- 2 = Pobre
    -- 3 = Normal
    -- 4 = Abundante
    -- 5 = Muy abundante
    NatureAbundance = 3,
    -- Probabilidad de que el jugador active una alarma al entrar en una nueva casa. Por defecto=A veces
    -- 1 = Nunca
    -- 2 = Muy raro
    -- 3 = Raro
    -- 4 = A veces
    -- 5 = A menudo
    -- 6 = Muy frecuentemente
    Alarm = 4,
    -- Con qué frecuencia se encontrarán las casas y los edificios cerrados con llave. Por defecto=Muy frecuentemente
    -- 1 = Nunca
    -- 2 = Muy raro
    -- 3 = Raro
    -- 4 = A veces
    -- 5 = A menudo
    -- 6 = Muy frecuentemente
    LockedHouses = 6,
    -- Apareces con patatas fritas, una botella de agua, una mochila escolar, un bate de béisbol y un martillo.
    StarterKit = false,
    -- El valor nutricional de los alimentos afecta a la condición del jugador.
    Nutrition = true,
    -- Define lo rápido que se estropeará la comida dentro o fuera de la nevera. Por defecto=Normal
    -- 1 = Muy rápido
    -- 2 = Rápido
    -- 3 = Normal
    -- 4 = Lento
    -- 5 = Muy lento
    FoodRotSpeed = 3,
    -- Establece la eficacia del frigorífico. Por defecto=Normal
    -- 1 = Muy baja
    -- 2 = Baja
    -- 3 = Normal
    -- 4 = Alta
    -- 5 = Muy alta
    -- 6 = Sin deterioro
    FridgeFactor = 3,
    -- Cuando es > 0, el botín no reaparecerá en las zonas que hayan sido visitadas dentro de este número de horas de juego. Mínimo=0 Máximo=2147483647 Por defecto=0
    SeenHoursPreventLootRespawn = 0,
    -- Cuando es mayor que 0, después de X horas, todos los contenedores en pueblos y parques de remolques reaparecerán botín. Para generar botín, un contenedor debe haber sido saqueado al menos una vez. Mínimo=0 Máximo=2147483647 Por defecto=0
    HoursForLootRespawn = 0,
    -- Los contenedores con un número de objetos mayor o igual a este valor no reaparecerán botín. Mínimo=0 Máximo=2147483647 Por defecto=5
    MaxItemsForLootRespawn = 5,
    -- Los objetos no reaparecerán en edificios que los jugadores hayan barricadeado o construido.
    ConstructionPreventsLootRespawn = true,
    -- Lista de objetos, separados por comas, que se eliminarán después de las horas especificadas.
    WorldItemRemovalList = "Base.Hat, Base.Glasses, Base.Maggots, Base.Slug, Base.Slug2, Base.Snail, Base.Worm, Base.Dung_Mouse, Base.Dung_Rat",
    -- Número de horas transcurridas desde que un objeto cayó al suelo antes de ser eliminado.  Los objetos se eliminan la próxima vez que se carga esa parte del mapa.  Cero significa que los objetos no se eliminan. Mínimo=0.00 Máximo=2147483647.00 Por defecto=24.00
    HoursForWorldItemRemoval = 24.0,
    -- Si está activado, cualquier objeto que NO esté en la lista de eliminación será eliminado.
    ItemRemovalListBlacklistToggle = false,
    -- Afectará a la erosión inicial del mundo y al deterioro de los alimentos. Por defecto=0
    -- 1 = 0
    -- 2 = 1
    -- 3 = 2
    -- 4 = 3
    -- 5 = 4
    -- 6 = 5
    -- 7 = 6
    -- 8 = 7
    -- 9 = 8
    -- 10 = 9
    -- 11 = 10
    -- 12 = 11
    -- 13 = 12
    TimeSinceApo = 1,
    -- Influirá en la cantidad de agua que la planta perderá por día y en su capacidad para evitar enfermedades. Por defecto=Normal
    -- 1 = Muy alto
    -- 2 = Alto
    -- 3 = Normal
    -- 4 = Bajo
    -- 5 = Muy bajo
    PlantResilience = 3,
    -- Controla la producción de las plantas cuando se cosechan. Por defecto=Normal
    -- 1 = Muy Pobre
    -- 2 = Pobre
    -- 3 = Normal
    -- 4 = Abundante
    -- 5 = Muy Abundante
    PlantAbundance = 3,
    -- Recuperación del cansancio por realizar acciones Por defecto=Normal
    -- 1 = Muy rápido
    -- 2 = Rápido
    -- 3 = Normal
    -- 4 = Lento
    -- 5 = Muy lento
    EndRegen = 3,
    -- Con qué frecuencia pasan los helicópteros por la zona de eventos. Por defecto=Una vez
    -- 1 = Nunca
    -- 2 = Una vez
    -- 3 = A veces
    -- 4 = A menudo
    Helicopter = 2,
    -- Con qué frecuencia se producirán eventos que atraigan a los zombis, como disparos lejanos. Por defecto=A veces
    -- 1 = Nunca
    -- 2 = A veces
    -- 3 = A menudo
    MetaEvent = 2,
    -- Regula los eventos nocturnos mientras el personaje duerme. Por defecto=Nunca
    -- 1 = Nunca
    -- 2 = A veces
    -- 3 = A menudo
    SleepingEvent = 1,
    -- Cuánto combustible se consume por hora de juego. Mínimo=0.00 Máximo=100.00 Por defecto=0.10
    GeneratorFuelConsumption = 0.1,
    -- Aumenta o disminuye la probabilidad de aparición en el mapa de generadores eléctricos. Por defecto=Raro
    -- 1 = Ninguno (no recomendado)
    -- 2 = Extremadamente Raro
    -- 3 = Muy Raro
    -- 4 = Raro
    -- 5 = Normal
    -- 6 = Común
    -- 7 = Abundante
    GeneratorSpawning = 4,
    -- Determina la frecuencia con la que un mapa puede tener anotaciones de un superviviente muerto. Por defecto=A veces
    -- 1 = Nunca
    -- 2 = Muy raro
    -- 3 = Raro
    -- 4 = A veces
    -- 5 = A menudo
    -- 6 = Muy frecuentemente
    AnnotatedMapChance = 4,
    -- Añade puntos gratis durante la creación del personaje. Mínimo=-100 Máximo=100 Por defecto=0
    CharacterFreePoints = 0,
    -- Proporciona a las construcciones creadas por los jugadores puntos de impacto adicionales para que sean más resistentes al daño de los zombis. Por defecto=Normal
    -- 1 = Muy bajo
    -- 2 = Bajo
    -- 3 = Normal
    -- 4 = Alto
    -- 5 = Muy alto
    ConstructionBonusPoints = 3,
    -- Controla la iluminación ambiental por la noche. Por defecto=Normal
    -- 1 = Noche cerrada
    -- 2 = Oscuro
    -- 3 = Normal
    -- 4 = Claro
    NightDarkness = 3,
    -- Controla el tiempo desde el atardecer hasta el amanecer. Por defecto=Normal
    -- 1 = Siempre de noche
    -- 2 = Largo
    -- 3 = Normal
    -- 4 = Corto
    -- 5 = Siempre de día
    NightLength = 3,
    -- Habilita o deshabilita la posibilidad de fracturas óseas cuando los personajes sufren lesiones por impactos, daños por zombis o caídas.
    BoneFracture = true,
    -- Aumenta o disminuye el impacto de las lesiones en tu cuerpo, así como el tiempo de curación. Por defecto=Normal
    -- 1 = Bajo
    -- 2 = Normal
    -- 3 = Alto
    InjurySeverity = 2,
    -- Cuánto tiempo antes de que desaparezcan los cuerpos de los zombis. Mínimo=-1.00 Máximo=2147483647.00 Por defecto=216.00
    HoursForCorpseRemoval = 216.0,
    -- Ajusta el impacto que tendrá en la salud y las emociones del personaje los cadáveres en descomposición cercanos a él. Por defecto=Normal
    -- 1 = Ninguno
    -- 2 = Bajo
    -- 3 = Normal
    -- 4 = Alto
    -- 5 = Insano
    DecayingCorpseHealthImpact = 3,
    -- Si los zombis "vivos" cercanos tienen el mismo impacto en la salud y emociones del jugador.
    ZombieHealthImpact = false,
    -- La cantidad de sangre que salpica el suelo y las paredes. Por defecto=Normal
    -- 1 = Ninguno
    -- 2 = Bajo
    -- 3 = Normal
    -- 4 = Alto
    -- 5 = Sangriento
    BloodLevel = 3,
    -- Controla la rapidez con la que la ropa se deteriora, se ensucia y se llena de sangre. Por defecto=Normal
    -- 1 = Deshabilitado
    -- 2 = Lento
    -- 3 = Normal
    -- 4 = Rápido
    ClothingDegradation = 3,
    -- Si los incendios se propagan cuando se inician.
    FireSpread = true,
    -- Número de días de juego antes de que los alimentos podridos sean retirados del mapa. -1 significa que los alimentos podridos nunca se eliminan. Mínimo=-1 Máximo=2147483647 Por defecto=-1
    DaysForRottenFoodRemoval = -1,
    -- Si está activado, los generadores funcionarán en el exterior, permitiendo por ejemplo, alimentar gasolineras.
    AllowExteriorGenerator = true,
    -- Controla la intensidad máxima de la niebla. Por defecto=Normal
    -- 1 = Normal
    -- 2 = Moderada
    -- 3 = Baja
    -- 4 = Ninguna
    MaxFogIntensity = 1,
    -- Controla la intensidad máxima de la lluvia. Por defecto=Normal
    -- 1 = Normal
    -- 2 = Moderado
    -- 3 = Bajo
    MaxRainFxIntensity = 1,
    -- Si está desactivado, la nieve no se acumulará en el suelo, pero seguirá siendo visible en la vegetación y en los tejados.
    EnableSnowOnGround = true,
    -- Desactivar para caminar sin problemas al atacar cuerpo a cuerpo.
    AttackBlockMovements = true,
    -- Aumentar/disminuir la probabilidad de descubrir refugios aleatorios en el mapa: ya sea quemados, que contengan reservas secretas, cadáveres de supervivientes, etc. Por defecto=Raro
    -- 1 = Nunca
    -- 2 = Muy raro
    -- 3 = Raro
    -- 4 = A veces
    -- 5 = A menudo
    -- 6 = Muy frecuentemente
    -- 7 = Siempre Intenta
    SurvivorHouseChance = 3,
    -- La probabilidad de que aparezcan historias en la carretera (por ejemplo, bloqueos policiales). Por defecto=Raro
    -- 1 = Nunca
    -- 2 = Muy raro
    -- 3 = Raro
    -- 4 = A veces
    -- 5 = A menudo
    -- 6 = Muy frecuentemente
    -- 7 = Siempre Intenta
    VehicleStoryChance = 3,
    -- La probabilidad de que aparezcan historias específicas de zonas del mapa (por ejemplo, un campamento en un bosque). Por defecto=Raro
    -- 1 = Nunca
    -- 2 = Muy raro
    -- 3 = Raro
    -- 4 = A veces
    -- 5 = A menudo
    -- 6 = Muy frecuentemente
    -- 7 = Siempre Intenta
    ZoneStoryChance = 3,
    -- Permite seleccionar cualquier prenda de ropa del juego al personalizar el personaje.
    AllClothesUnlocked = false,
    -- Si está desactivado, no habrá una advertencia que indique que el agua está contaminada.
    EnableTaintedWaterText = true,
    -- Permite la aparición de vehículos.
    EnableVehicles = true,
    -- Regula la frecuencia con la que se encuentran los coches en el mapa. Por defecto=Bajo
    -- 1 = Ninguno
    -- 2 = Muy bajo
    -- 3 = Bajo
    -- 4 = Normal
    -- 5 = Alto
    CarSpawnRate = 3,
    -- Se usa para multiplicar o reducir el volumen general del motor. Mínimo=0.00 Máximo=100.00 Por defecto=1.00
    ZombieAttractionMultiplier = 1.0,
    -- Controla si los coches están cerrados, necesitan llaves para arrancar, etc.
    VehicleEasyUse = false,
    -- Determina qué tan llenos estarán los tanques de gasolina en los vehículos encontrados. Por defecto=Bajo
    -- 1 = Muy bajo
    -- 2 = Bajo
    -- 3 = Normal
    -- 4 = Alto
    -- 5 = Muy alto
    -- 6 = Lleno
    InitialGas = 2,
    -- Si está habilitado, las bombas de gasolina nunca se quedarán sin combustible.
    FuelStationGasInfinite = false,
    -- La cantidad mínima de gasolina que puede aparecer en las bombas de gasolina. Marca la casilla "Avanzado" para usar una cantidad personalizada. Mínimo=0.00 Máximo=1.00 Por defecto=0.00
    FuelStationGasMin = 0.0,
    -- La cantidad máxima de gasolina que puede aparecer en las bombas de gasolina. Marca la casilla "Avanzado" para usar una cantidad personalizada. Mínimo=0.00 Máximo=1.00 Por defecto=0.80
    FuelStationGasMax = 0.8,
    -- La probabilidad, como porcentaje, de que las bombas de gasolina estén vacías al inicio. Mínimo=0 Máximo=100 Por defecto=20
    FuelStationGasEmptyChance = 20,
    -- Probabilidad de que los autos estén cerrados con llave. Por defecto=A veces
    -- 1 = Nunca
    -- 2 = Muy raro
    -- 3 = Raro
    -- 4 = A veces
    -- 5 = A menudo
    -- 6 = Muy frecuentemente
    LockedCar = 4,
    -- Cuánta gasolina tienen los vehículos en el mapa. Mínimo=0.00 Máximo=100.00 Por defecto=1.00
    CarGasConsumption = 1.0,
    -- Estado general de los vehículos encontrados en el mapa. Por defecto=Normal
    -- 1 = Muy bajo
    -- 2 = Bajo
    -- 3 = Normal
    -- 4 = Alto
    -- 5 = Muy alto
    CarGeneralCondition = 3,
    -- Determina la cantidad de daños causados a los vehículos en caso de colisión. Por defecto=Normal
    -- 1 = Muy bajo
    -- 2 = Bajo
    -- 3 = Normal
    -- 4 = Alto
    -- 5 = Muy alto
    CarDamageOnImpact = 3,
    -- Daño que recibe el jugador del vehículo en una colisión. Por defecto=Ninguno
    -- 1 = Ninguno
    -- 2 = Bajo
    -- 3 = Normal
    -- 4 = Alto
    -- 5 = Muy alto
    DamageToPlayerFromHitByACar = 1,
    -- Activar o desactivar los bloqueos de tráfico que se producen en las principales carreteras del mapa.
    TrafficJam = true,
    -- Frecuencia con la que se descubren coches con alarma. Por defecto=Raro
    -- 1 = Nunca
    -- 2 = Muy raro
    -- 3 = Raro
    -- 4 = A veces
    -- 5 = A menudo
    -- 6 = Muy frecuentemente
    CarAlarm = 3,
    -- Permite o impide que el jugador reciba daños por sufrir un accidente de coche.
    PlayerDamageFromCrash = true,
    -- Cuántas horas en el juego antes de que se apague la alarma. Mínimo=0.00 Máximo=168.00 Por defecto=0.00
    SirenShutoffHours = 0.0,
    -- Determina la probabilidad de encontrar vehículos con combustible en el depósito. Por defecto=Normal
    -- 1 = Bajo
    -- 2 = Normal
    -- 3 = Alto
    ChanceHasGas = 2,
    --  Determina si el jugador puede encontrar un vehículo que haya sido conservado y acondicionado después de que se haya producido la infección. Por defecto=Bajo
    -- 1 = Ninguno
    -- 2 = Bajo
    -- 3 = Normal
    -- 4 = Alto
    RecentlySurvivorVehicles = 2,
    -- Al activarse, ciertas armas de combate cuerpo a cuerpo serán capaces de golpear a varios zombis en un solo golpe.
    MultiHitZombies = false,
    -- Posibilidad de ser mordido cuando un zombi ataca por detrás. Por defecto=Alto
    -- 1 = Bajo
    -- 2 = Medio
    -- 3 = Alto
    RearVulnerability = 3,
    -- Si los zombis se dirigirán hacia el sonido de las sirenas de vehículos.
    SirenEffectsZombies = true,
    -- Velocidad a la que se reducen las estadísticas de los animales (hambre, sed, etc.). Por defecto=Normal
    -- 1 = Ultrarrápido
    -- 2 = Muy Rápido
    -- 3 = Rápido
    -- 4 = Normal
    -- 5 = Lento
    -- 6 = Muy Lento
    AnimalStatsModifier = 4,
    -- Velocidad a la que se reducen las estadísticas de los animales mientras están en metadatos (meta). Por defecto=Normal
    -- 1 = Ultrarrápido
    -- 2 = Muy Rápido
    -- 3 = Rápido
    -- 4 = Normal
    -- 5 = Lento
    -- 6 = Muy Lento
    AnimalMetaStatsModifier = 4,
    -- Tiempo que los animales estarán embarazados antes de dar a luz. Por defecto=Normal
    -- 1 = Ultrarrápido
    -- 2 = Muy Rápido
    -- 3 = Rápido
    -- 4 = Normal
    -- 5 = Lento
    -- 6 = Muy Lento
    AnimalPregnancyTime = 4,
    -- Velocidad a la que envejecen los animales. Por defecto=Normal
    -- 1 = Ultrarrápido
    -- 2 = Muy Rápido
    -- 3 = Rápido
    -- 4 = Normal
    -- 5 = Lento
    -- 6 = Muy Lento
    AnimalAgeModifier = 4,
    -- Por defecto=Normal
    -- 1 = Ultrarrápido
    -- 2 = Muy Rápido
    -- 3 = Rápido
    -- 4 = Normal
    -- 5 = Lento
    -- 6 = Muy Lento
    AnimalMilkIncModifier = 4,
    -- Por defecto=Normal
    -- 1 = Ultrarrápido
    -- 2 = Muy Rápido
    -- 3 = Rápido
    -- 4 = Normal
    -- 5 = Lento
    -- 6 = Muy Lento
    AnimalWoolIncModifier = 4,
    -- La probabilidad de encontrar animales en una granja. Por defecto=Frecuente
    -- 1 = Nunca
    -- 2 = Extremadamente Rara
    -- 3 = Rara
    -- 4 = A Veces
    -- 5 = Frecuente
    -- 6 = Muy Frecuente
    -- 7 = Siempre
    AnimalRanchChance = 5,
    -- El número de horas en que el pasto se regenerará después de ser comido por un animal o cortado por el jugador. Mínimo=1 Máximo=9999 Por defecto=240
    AnimalGrassRegrowTime = 240,
    -- Si un zorro meta (es decir, no visible en el juego) puede atacar  a tus gallinas si la puerta del gallinero se deja abierta por la noche.
    AnimalMetaPredator = false,
    -- Si los animales con una temporada de apareamiento respetarán esa temporada. De lo contrario, pueden reproducirse/poner huevos durante todo el año.
    AnimalMatingSeason = true,
    -- Tiempo antes de que los animales bebés nazcan de los huevos. Por defecto=Normal
    -- 1 = Ultrarrápido
    -- 2 = Muy Rápido
    -- 3 = Rápido
    -- 4 = Normal
    -- 5 = Lento
    -- 6 = Muy Lento
    AnimalEggHatch = 4,
    -- Si está habilitado, los sonidos de los animales atraerán a los zombis cercanos.
    AnimalSoundAttractZombies = true,
    -- La probabilidad de que los animales dejen huellas. Por defecto=A veces
    -- 1 = Nunca
    -- 2 = Muy raro
    -- 3 = Raro
    -- 4 = A veces
    -- 5 = A menudo
    -- 6 = Muy frecuentemente
    AnimalTrackChance = 4,
    -- La probabilidad de que se generen sendas donde puedan cazarse animales. Por defecto=A veces
    -- 1 = Nunca
    -- 2 = Muy raro
    -- 3 = Raro
    -- 4 = A veces
    -- 5 = A menudo
    -- 6 = Muy frecuentemente
    AnimalPathChance = 4,
    -- La frecuencia e intensidad, por ejemplo, de ratas en edificios infestados. Mínimo=0 Máximo=50 Por defecto=25
    MaximumRatIndex = 25,
    -- Cuánto tiempo tarda en alcanzarse el índice máximo de plagas. Mínimo=0 Máximo=365 Por defecto=90
    DaysUntilMaximumRatIndex = 90,
    -- Si una pieza de medios no se ha visto o leído completamente, esta configuración determina si se muestra completa, como "???" o se oculta por completo. Por defecto=Completamente oculto
    -- 1 = Totalmente revelado
    -- 2 = Mostrado como ???
    -- 3 = Completamente oculto
    MetaKnowledge = 3,
    -- Si está habilitado, podrás ver recetas que pueden hacerse con una estación, incluso si aún no las has aprendido.
    SeeNotLearntRecipe = true,
    -- Si un edificio tiene más de esta cantidad de habitaciones, no será saqueado. Mínimo=0 Máximo=200 Por defecto=50
    MaximumLootedBuildingRooms = 50,
    -- Determina si se habilita el envenenamiento de los alimentos. Por defecto=Verdadero
    -- 1 = Verdadero
    -- 2 = Falso
    -- 3 = Sólo está deshabilitado el envenenamiento por lejía
    EnablePoisoning = 1,
    -- Si/cuándo pueden aparecer gusanos en los cadáveres. Por defecto=Dentro y alrededor de los cuerpos
    -- 1 = Dentro y alrededor de los cuerpos
    -- 2 = Sólo dentro de los cuerpos
    -- 3 = Nunca
    MaggotSpawn = 1,
    -- Cuanto más alto sea el valor, más tiempo durarán las bombillas antes de romperse. Si es 0, las bombillas no se romperán nunca. No afecta a los faros del vehículo. Mínimo=0.00 Máximo=1000.00 Por defecto=2.00
    LightBulbLifespan = 2.0,
    -- La abundancia de peces en ríos y lagos. Por defecto=Pobre
    -- 1 = Muy Pobre
    -- 2 = Pobre
    -- 3 = Normal
    -- 4 = Abundante
    -- 5 = Muy Abundante
    FishAbundance = 2,
    -- Cuando una habilidad alcanza este nivel o más, la televisión/VHS/otros medios no proporcionarán XP para esa habilidad. Mínimo=0 Máximo=10 Por defecto=3
    LevelForMediaXPCutoff = 3,
    -- Cuando una habilidad alcanza este nivel o más, desmantelar muebles no proporciona XP para la habilidad relevante. No se aplica a Electricidad. Mínimo=0 Máximo=10 Por defecto=0
    LevelForDismantleXPCutoff = 0,
    -- Número de días antes de que se eliminen las salpicaduras de sangre viejas. La eliminación ocurre cuando se cargan fragmentos del mapa. Un valor de 0 significa que nunca desaparecerán. Mínimo=0 Máximo=365 Por defecto=0
    BloodSplatLifespanDays = 0,
    -- Número de días antes de que se pueda beneficiar de nuevo de leer elementos literarios previamente leídos. Mínimo=1 Máximo=365 Por defecto=45
    LiteratureCooldown = 45,
    -- Si hay retornos decrecientes en los puntos de bonificación otorgados al seleccionar múltiples rasgos negativos. Por defecto=Ninguna
    -- 1 = Ninguna
    -- 2 = 1 punto de penalización por cada 3 rasgos negativos seleccionados
    -- 3 = 1 punto de penalización por cada 2 rasgos negativos seleccionados
    -- 4 = 1 punto de penalización por cada rasgo negativo seleccionado después del primero
    NegativeTraitsPenalty = 1,
    -- Número de minutos en el juego que toma leer una página de un libro de habilidades. Mínimo=0.00 Máximo=60.00 Por defecto=2.00
    MinutesPerPage = 2.0,
    -- Cuando está habilitado, los cultivos y hierbas cultivados dentro de edificios morirán. No afecta a plantas de interior decorativas.
    KillInsideCrops = true,
    -- Cuando está habilitado, el crecimiento de las plantas se ve afectado por las estaciones.
    PlantGrowingSeasons = true,
    -- <BHC> [!] Se recomienda que NO cambies esto. Cambiarlo puede provocar problemas de rendimiento. [!] <RGB:1,1,1>   Cuando está habilitado, se puede colocar tierra y realizar actividades agrícolas en niveles distintos al suelo.
    PlaceDirtAboveground = false,
    -- La velocidad de crecimiento de las plantas. Mínimo=0.10 Máximo=100.00 Por defecto=1.00
    FarmingSpeedNew = 1.0,
    -- La abundancia de cultivos cosechados. Mínimo=0.10 Máximo=10.00 Por defecto=1.00
    FarmingAmountNew = 1.0,
    -- La probabilidad de que cualquier edificio ya haya sido saqueado cuando se encuentre. Marca la casilla "Avanzado" para usar un número personalizado. Mínimo=0 Máximo=200 Por defecto=25
    MaximumLooted = 25,
    -- Cuánto tiempo toma alcanzar la probabilidad máxima de edificios saqueados. Mínimo=0 Máximo=3650 Por defecto=90
    DaysUntilMaximumLooted = 90,
    -- La probabilidad de que cualquier edificio rural ya haya sido saqueado cuando se encuentre. Marca la casilla "Avanzado" para usar un número personalizado. Mínimo=0.00 Máximo=2.00 Por defecto=0.50
    RuralLooted = 0.5,
    -- El máximo de botín que no aparecerá cuando se alcance el límite de días para botín reducido. Marca la casilla "Avanzado" para usar un porcentaje exacto. Mínimo=0 Máximo=100 Por defecto=20
    MaximumDiminishedLoot = 20,
    -- Días hasta que se alcance el máximo de botín reducido. Mínimo=0 Máximo=3650 Por defecto=3650
    DaysUntilMaximumDiminishedLoot = 3650,
    -- Funciona como multiplicador al aplicar tensión muscular por balanceo de armas o carga de peso. Mínimo=0.00 Máximo=10.00 Por defecto=0.70
    MuscleStrainFactor = 0.7,
    -- Funciona como un multiplicador al aplicar incomodidad por los artículos usados. Mínimo=0.00 Máximo=10.00 Por defecto=0.80
    DiscomfortFactor = 0.8,
    -- Si es mayor que cero, puede recibirse daño por infecciones graves en heridas. Mínimo=0.00 Máximo=10.00 Por defecto=1.00
    WoundInfectionFactor = 1.0,
    -- Si está habilitado, la ropa con tonos aleatorios no será tan oscura como para parecer negra.
    NoBlackClothes = true,
    -- Desactiva las posibilidades de fallar al escalar cuerdas de sábana o saltar paredes.
    EasyClimbing = false,
    -- Las horas máximas de combustible que se pueden colocar en una fogata, estufa de leña, etc. Mínimo=1 Máximo=168 Por defecto=8
    MaximumFireFuelHours = 8,
    -- Sustituye la mecánica de probabilidad de acierto por cálculos de probabilidad de daño. Este modo prioriza la puntería del jugador. Por defecto=Solo zombis
    -- 1 = Desactivado
    -- 2 = Solo zombis
    -- 3 = Todos los tipos de objetivo
    FirearmUseDamageChance = 2,
    -- Un multiplicador para la distancia a la que los zombis pueden escuchar disparos. Mínimo=0.20 Máximo=2.00 Por defecto=1.00
    FirearmNoiseMultiplier = 1.0,
    -- Multiplicador para la probabilidad de que las armas de fuego se atasquen. Un valor de 0 desactiva los atascos. Mínimo=0.00 Máximo=10.00 Por defecto=1.00
    FirearmJamMultiplier = 1.0,
    -- Multiplicador para los efectos de estado de ánimo en la precisión de disparos. Un valor de 0 desactiva la penalización por estado de ánimo. Mínimo=0.00 Máximo=10.00 Por defecto=1.00
    FirearmMoodleMultiplier = 1.0,
    -- Multiplicador para los efectos del clima (viento, lluvia y niebla) en la precisión de disparos. Un valor de 0 desactiva el efecto del clima. Mínimo=0.00 Máximo=10.00 Por defecto=1.00
    FirearmWeatherMultiplier = 1.0,
    -- Habilita que la protección para la cabeza, como máscaras de soldadura, afecten la precisión de disparos.
    FirearmHeadGearEffect = true,
    -- Probabilidad de convertir un suelo de tierra en un suelo de arcilla. Se aplica a los lagos. Mínimo=0.00 Máximo=1.00 Por defecto=0.05
    ClayLakeChance = 0.05,
    -- Probabilidad de convertir un suelo de tierra en un suelo de arcilla. Se aplica a los ríos. Mínimo=0.00 Máximo=1.00 Por defecto=0.05
    ClayRiverChance = 0.05,
    -- Mínimo=1 Máximo=100 Por defecto=20
    GeneratorTileRange = 20,
    -- Cuántos pisos hacia arriba y hacia abajo puede alimentar con electricidad un generador. Mínimo=1 Máximo=15 Por defecto=3
    GeneratorVerticalPowerRange = 3,
    Basement = {
        -- Con qué frecuencia aparecen sótanos en ubicaciones aleatorias. Por defecto=A Veces
        -- 1 = Nunca
        -- 2 = Extremadamente Rara
        -- 3 = Rara
        -- 4 = A Veces
        -- 5 = Frecuente
        -- 6 = Muy Frecuente
        -- 7 = Siempre
        SpawnFrequency = 4,
    },
    Map = {
        -- Si está habilitado, estará disponible una ventana de minimapa.
        AllowMiniMap = false,
        -- Si está habilitado, se puede acceder al mapa mundial.
        AllowWorldMap = true,
        -- Si está habilitado, el mapa mundial estará completamente revelado al comenzar el juego.
        MapAllKnown = false,
        -- Si está habilitado, los mapas no se pueden leer a menos que haya una fuente de luz disponible.
        MapNeedsLight = true,
    },
    ZombieLore = {
        -- Controla la velocidad de movimiento de los zombis. Por defecto=Aleatorio
        -- 1 = Velocistas
        -- 2 = Tambaleantes veloces
        -- 3 = Tambaleantes
        -- 4 = Aleatorio
        Speed = 4,
        -- Si Velocidad aleatoria está activada, esto controla qué porcentaje de zombis son Sprinters. Marca la casilla "Avanzado" de abajo para usar un porcentaje personalizado. Mínimo=0 Máximo=100 Por defecto=0
        SprinterPercentage = 0,
        -- Controla el daño que infligen los zombis por ataque. Por defecto=Normal
        -- 1 = Superhumano
        -- 2 = Normal
        -- 3 = Débil
        -- 4 = Aleatorio
        Strength = 2,
        -- Controla la dificultad para matar zombis. Por defecto=Aleatorio
        -- 1 = Duro
        -- 2 = Normal
        -- 3 = Frágil
        -- 4 = Aleatorio
        Toughness = 4,
        -- Controla cómo se propaga el virus zombi. Por defecto=Sangre + saliva
        -- 1 = Sangre + saliva
        -- 2 = Sólo saliva
        -- 3 = Todos están infectados
        -- 4 = Ninguno
        Transmission = 1,
        -- Controla la rapidez con la que la infección hace efecto. Por defecto=2-3 días
        -- 1 = Instantáneo
        -- 2 = 0-30 segundos
        -- 3 = 0-1 minuto
        -- 4 = 0-12 horas
        -- 5 = 2-3 días
        -- 6 = 1-2 semanas
        -- 7 = Nunca
        Mortality = 5,
        -- Controla la rapidez con la que los cadáveres se levantan como zombis. Por defecto=0-1 minuto
        -- 1 = Instantáneo
        -- 2 = 0-30 segundos
        -- 3 = 0-1 minuto
        -- 4 = 0-12 horas
        -- 5 = 2-3 días
        -- 6 = 1-2 semanas
        Reanimate = 3,
        -- Controla la inteligencia de los zombis. Por defecto=Exploración básica
        -- 1 = Exploración + usar las puertas
        -- 2 = Exploración
        -- 3 = Exploración básica
        -- 4 = Aleatorio
        Cognition = 3,
        -- Mínimo=0 Máximo=100 Por defecto=0
        DoorOpeningPercentage = 0,
        -- Controla qué zombis pueden arrastrarse bajo los vehículos. Por defecto=A menudo
        -- 1 = Sólo reptantes
        -- 2 = Extremadamente raro
        -- 3 = Raro
        -- 4 = A veces
        -- 5 = A menudo
        -- 6 = Muy a menudo
        -- 7 = Siempre
        CrawlUnderVehicle = 5,
        -- Controla durante cuánto tiempo los zombis recuerdan a los jugadores después de haberlos visto o escuchado. Por defecto=Normal
        -- 1 = Larga
        -- 2 = Normal
        -- 3 = Corta
        -- 4 = Ninguna
        -- 5 = Aleatoria
        -- 6 = Aleatorio entre Normal y Ninguno
        Memory = 2,
        -- Controla el radio de visión de los zombis. Por defecto=Aleatorio entre Normal y Pobre
        -- 1 = Águila
        -- 2 = Normal
        -- 3 = Mala
        -- 4 = Aleatoria
        -- 5 = Aleatorio entre Normal y Pobre
        Sight = 5,
        -- Controla el radio de audición de los zombis. Por defecto=Aleatorio entre Normal y Pobre
        -- 1 = Precisa
        -- 2 = Normal
        -- 3 = Mala
        -- 4 = Aleatoria
        -- 5 = Aleatorio entre Normal y Pobre
        Hearing = 5,
        -- Activa las nuevas mecánicas avanzadas de sigilo, que permiten esconderse de los zombis detrás de autos, teniendo en cuenta rasgos, clima y más.
        SpottedLogic = true,
        -- Los zombis que no han visto/escuchado al jugador pueden atacar puertas y construcciones mientras deambulan.
        ThumpNoChasing = false,
        -- Determina si los zombis pueden o no destruir las construcciones y defensas de los jugadores.
        ThumpOnConstruction = true,
        -- Controla si los zombis son más activos durante el día o si actúan más de noche.  Los zombis activos utilizarán la velocidad establecida en el ajuste "Velocidad". Los zombis inactivos serán más lentos y tenderán a no perseguir. Por defecto=Ambos
        -- 1 = Ambos
        -- 2 = Noche
        -- 3 = Día
        ActiveOnly = 1,
        -- Permite a los zombis activar las alarmas de las casas al atravesar ventanas y puertas.
        TriggerHouseAlarm = true,
        -- Cuando se activa, si varios zombis atacan, pueden derribarte. Depende de la fuerza del zombi.
        ZombiesDragDown = true,
        -- Si los zombis reptantes junto al jugador contribuyen a la probabilidad de ser derribado y asesinado por un grupo de zombis.
        ZombiesCrawlersDragDown = false,
        -- Cuando esté habilitado, los zombis tendrán la oportunidad de arremeter después de pasar por encima de una valla si estás demasiado cerca.
        ZombiesFenceLunge = true,
        -- Sirve como multiplicador al determinar la efectividad de la armadura que usan los zombis. Mínimo=0.00 Máximo=100.00 Por defecto=2.00
        ZombiesArmorFactor = 2.0,
        -- El porcentaje máximo de defensa que cualquier prenda protectora puede proporcionar a un zombi. Mínimo=0 Máximo=100 Por defecto=85
        ZombiesMaxDefense = 85,
        -- Porcentaje de probabilidad de que un zombi tenga un arma adjunta aleatoria. Mínimo=0 Máximo=100 Por defecto=6
        ChanceOfAttachedWeapon = 6,
        -- Cuánto daño reciben los zombis al caer desde una altura. Mínimo=0.00 Máximo=100.00 Por defecto=1.00
        ZombiesFallDamage = 1.0,
        -- Si algunos zombis que parecen muertos reaniman y atacan al jugador. Por defecto=Algunos zombis del mundo se harán pasar por muertos
        -- 1 = Algunos zombis del mundo se harán pasar por muertos
        -- 2 = Algunos zombis del mundo, así como algunos que "matas", pueden fingir estar muertos
        -- 3 = Los zombis nunca fingirán estar muertos
        DisableFakeDead = 1,
        -- Los zombis no aparecerán donde los jugadores aparecen. Por defecto=Dentro del edificio y alrededor
        -- 1 = Dentro del edificio y alrededor
        -- 2 = Dentro del edificio
        -- 3 = Dentro de la habitación
        -- 4 = Los zombis pueden aparecer en cualquier lugar
        PlayerSpawnZombieRemoval = 1,
        -- Cuántos zombis se necesitan para dañar una valla alta. Mínimo=-1 Máximo=100 Por defecto=25
        FenceThumpersRequired = 25,
        -- Qué tan rápido dañan las vallas altas los zombis. Mínimo=0.01 Máximo=100.00 Por defecto=1.00
        FenceDamageMultiplier = 1.0,
    },
    ZombieConfig = {
        -- Se establece mediante la opción de población "Cantidad de zombis", o mediante un número personalizado aquí. Insano= 2.5, Muy alta = 1.6, Alta = 1.2, Normal = 0.65, Baja = 0.15, Ninguna = 0.0. Mínimo=0.00 Máximo=4.00 Por defecto=0.65
        PopulationMultiplier = 0.65,
        -- Un multiplicador para la población de zombis deseada al inicio de la partida. Insano= 3.0, Muy alta = 2.0, Alta = 1.5, Normal = 1.0, Baja = 0.5, Ninguna = 0.0. Mínimo=0.00 Máximo=4.00 Por defecto=1.00
        PopulationStartMultiplier = 1.0,
        -- Un multiplicador para la población de zombis deseada en el día pico. Insano= 3.0, Muy alta = 2.0, Alta = 1.5, Normal = 1.0, Baja = 0.5, Ninguna = 0.0. Mínimo=0.00 Máximo=4.00 Por defecto=1.50
        PopulationPeakMultiplier = 1.5,
        -- El día cuando la población llega a su punto máximo. Mínimo=1 Máximo=365 Por defecto=28
        PopulationPeakDay = 28,
        -- El número de horas que debe transcurrir antes de que los zombis pueden reaparecer en una celda. Si es cero, la reaparición se desactiva. Mínimo=0.00 Máximo=8760.00 Por defecto=0.00
        RespawnHours = 0.0,
        -- El número de horas que una zona no debe ser visitada antes que los zombis puedan reaparecer en la misma. Mínimo=0.00 Máximo=8760.00 Por defecto=0.00
        RespawnUnseenHours = 0.0,
        -- La fracción de la población deseada de una celda que puede reaparecer cada Horas para reaparición. Mínimo=0.00 Máximo=1.00 Por defecto=0.00
        RespawnMultiplier = 0.0,
        -- El número de horas que deben pasar para que los zombis migren a partes vacía de la misma celda. Si es cero, la migración se desactiva. Mínimo=0.00 Máximo=8760.00 Por defecto=12.00
        RedistributeHours = 12.0,
        -- La distancia a la que un zombi intentará caminar hacia el último sonido que escuchó. Mínimo=10 Máximo=1000 Por defecto=100
        FollowSoundDistance = 100,
        -- El tamaño de los grupos de zombis reales que se forman cuando están inactivos. Cero significa que no forman grupos. Los grupos no se forman en edificios ni bosques. Mínimo=0 Máximo=1000 Por defecto=20
        RallyGroupSize = 20,
        -- El porcentaje en que los grupos de zombis pueden variar en tamaño desde el valor predeterminado (tanto más grandes como más pequeños). Por ejemplo, con un 50% de varianza y un tamaño de grupo predeterminado de 20, los grupos variarán entre 10-30. Mínimo=0 Máximo=100 Por defecto=50
        RallyGroupSizeVariance = 50,
        -- Distancia real que recorren los zombis para formar grupos cuando están inactivos. Mínimo=5 Máximo=50 Por defecto=20
        RallyTravelDistance = 20,
        -- La distancia entre los grupos de zombies. Mínimo=5 Máximo=25 Por defecto=15
        RallyGroupSeparation = 15,
        -- Cercanía que mantienen los miembros del grupo con el líder del mismo. Mínimo=1 Máximo=10 Por defecto=3
        RallyGroupRadius = 3,
        -- Controla el número máximo de zombis rastreados antes de que se produzca la limpieza. 0 significa que los zombis no se limpiarán. El valor predeterminado (300) es muy recomendable. Aumentar este valor o establecerlo en 0 puede causar graves problemas de rendimiento. Para fines de resolución de problemas e informes de errores, reproduce cualquier problema con la configuración predeterminada antes de enviar un informe. Mínimo=0 Máximo=5000 Por defecto=300
        ZombiesCountBeforeDelete = 300,
    },
    MultiplierConfig = {
        -- La tasa a la que se suben de nivel todas las habilidades. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Global = 1.0,
        -- Cuando está habilitado, todas las habilidades usarán el multiplicador global.
        GlobalToggle = true,
        -- Tasa a la que se sube de nivel la habilidad de Estado Físico Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Fitness = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Fuerza. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Strength = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Carrera. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Sprinting = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Pies Ligeros. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Lightfoot = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Destreza. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Nimble = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Sigilo. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Sneak = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Hacha. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Axe = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Armas Largas Contundentes. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Blunt = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Armas Cortas Contundentes . Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        SmallBlunt = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Armas de Hoja Larga. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        LongBlade = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Armas de Hoja Corta. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        SmallBlade = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Lanza. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Spear = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Mantenimiento. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Maintenance = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Carpintería. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Woodwork = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Cocina. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Cooking = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Agricultura. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Farming = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Primeros Auxilios. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Doctor = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Electricidad. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Electricity = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Metalistería. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        MetalWelding = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Mecánica. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Mechanics = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Sastrería. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Tailoring = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Puntería. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Aiming = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Recarga. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Reloading = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Pesca. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Fishing = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Trampas. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Trapping = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Recolección. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        PlantScavenging = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Labrar Piedra Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        FlintKnapping = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Albañilería. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Masonry = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Alfarería. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Pottery = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Tallar. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Carving = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Cuidado Animal. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Husbandry = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Rastrear. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Tracking = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Herrería. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Blacksmith = 1.0,
        -- Tasa a la que se sube de nivel la habilidad de Carnicería. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Butchering = 1.0,
        -- Velocidad a la que sube de nivel la habilidad de Cristalería. Mínimo=0.00 Máximo=1000.00 Por defecto=1.00
        Glassmaking = 1.0,
    },
}
