window.CARGO_SITE_CONFIG = {
  baseUrl: "https://thingspeak.mathworks.com",
  channelId: "3365338",
  readApiKey: "MDDR3MKTSRKRETR4",
  writeApiKey: "H7Y5E9R3AXKW2NAT",
  dashboardUrl: "https://thingspeak.com/channels/3365338",
  results: 60,
  fields: [
    { field: 1, title: "Total Weight",          description: "Total weight measured across the cargo load.",                  sensorKey: "total",  unit: "kg",   max: 1000, warnAt: 500, dangerAt: 700 },
    { field: 2, title: "Front Weight",          description: "Front axle load-cell weight for balance and overload detection.", sensorKey: "front",  unit: "kg",   max: 1000, warnAt: 500, dangerAt: 700 },
    { field: 3, title: "Back Weight",           description: "Rear axle load-cell weight for overload detection.",             sensorKey: "back",   unit: "kg",   max: 1000, warnAt: 500, dangerAt: 700 },
    { field: 4, title: "Raw Acceleration Z",    description: "Captures braking and impact motion events on the cargo.",        sensorKey: "accel",  unit: "m/s²", max: 30,   warnAt: 8,   dangerAt: 15  },
    { field: 5, title: "Vibration (Shock)",     description: "Road-shock vibration spikes that may damage cargo.",             sensorKey: "vib",    unit: "m/s²", max: 30,   warnAt: 8,   dangerAt: 15  },
    { field: 6, title: "Dynamic Tilt Angle",    description: "Cargo tilt angle — alerts on rollover risk.",                   sensorKey: "tilt",   unit: "deg",  max: 90,   warnAt: 15,  dangerAt: 30  },
    { field: 7, title: "Latitude",              description: "GPS latitude coordinate for real-time cargo location tracking.", sensorKey: "lat",    unit: "°",    max: 90,   warnAt: null, dangerAt: null },
    { field: 8, title: "Longitude",             description: "GPS longitude coordinate for real-time cargo location tracking.", sensorKey: "lng",   unit: "°",    max: 180,  warnAt: null, dangerAt: null }
  ]
};