# Smart Home Geräte-Referenz

## Wohnzimmer
- Abendlicht (WZ): `light.abendlicht_wz`
- LED-Stripe: `light.led_stripe_wz_flex_color_3`
- Kugellampe: `light.kugellampe_level_light_color_on_off`
- Rohrlampe: `light.rohrlampe_level_light_color_on_off`
- Stehlampe: `light.stehlampe_level_light_color_on_off`
- Thermostat (WZE): `climate.lumi_lumi_airrtc_agl001_thermostat_2`
- Thermostat (WZ): `climate.lumi_lumi_airrtc_agl001_thermostat_3`
- Temperatur: `sensor.lumi_lumi_weather_temperature` (Multisensor WZ)
- Luftfeuchte: `sensor.lumi_lumi_weather_humidity`
- Fensterkontakt (WZE): `binary_sensor.lumi_lumi_sensor_magnet_aq2_opening`
- Fensterkontakt (WZ): `binary_sensor.lumi_lumi_sensor_magnet_aq2_opening_2`

## Arbeitszimmer
- Steckdose 1 (AZ): `light.steckdose_1_az_schalter` / `switch.lumi_lumi_plug_maeu01_switch`
- Schranklicht (AZ): `light.schranklicht_az_leuchte`
- LED Light Stripe: `light.led_light_stripe_leuchte`
- Decken LED Außen (AZ): `light.decken_led_aussen_az`
- Decken LED Innen (AZ): `light.decken_led_innen_az`
- Thermostat (AZ): `climate.lumi_lumi_airrtc_agl001_thermostat_7`
- Thermostat (AZE): `climate.lumi_lumi_airrtc_agl001_thermostat_8`
- Temperatur: `sensor.lumi_lumi_weather_temperature_5` (Multisensor AZ)
- Luftfeuchte: `sensor.lumi_lumi_weather_humidity_5`
- Steckdose 3 Nerd2Miner: `switch.lumi_lumi_plug_maeu01_switch_4`
- Fensterkontakt (AZ): `binary_sensor.lumi_lumi_sensor_magnet_aq2_opening_8`
- Fensterkontakt (AZE): `binary_sensor.lumi_lumi_sensor_magnet_aq2_opening_9`

## Schlafzimmer
- Michael LED: `light.michael_level_light_color_on_off`
- Lea LED: `light.lea_level_light_color_on_off`
- Thermostat (SZ): `climate.lumi_lumi_airrtc_agl001_thermostat_6`
- Temperatur: `sensor.lumi_lumi_weather_temperature_3` (Multisensor SZ)
- Luftfeuchte: `sensor.lumi_lumi_weather_humidity_3`

## Küche
- Nachtlicht (K): `light.nachtlicht_k_licht`
- Steckdose 2 (K): `switch.lumi_lumi_plug_maeu01_switch_2`
- Temperatur: `sensor.lumi_lumi_weather_temperature_8` (Multisensor K)
- Luftfeuchte: `sensor.lumi_lumi_weather_humidity_8`
- Türkontakt (K): `binary_sensor.lumi_lumi_sensor_magnet_aq2_opening_3`

## Badezimmer
- Spot Hinten (BZ): `light.spot_hinten_bz_licht`
- Spot Vorne (BZ): `light.spot_vorne_bz_licht`
- Thermostat (BZ): `climate.lumi_lumi_airrtc_agl001_thermostat_4`
- Temperatur: `sensor.lumi_lumi_weather_temperature_6` (Multisensor BZ)
- Luftfeuchte: `sensor.lumi_lumi_weather_humidity_6`
- Fensterkontakt (BZ): `binary_sensor.lumi_lumi_sensor_magnet_aq2_opening_5`
- Bewegungssensor (BZ): `binary_sensor.bewegungssensor_bz_belegung`

## WC
- LED (WC): `light.led_wc_level_light_color_on_off`
- Thermostat (WC): `climate.lumi_lumi_airrtc_agl001_thermostat_5`
- Temperatur: `sensor.lumi_lumi_weather_temperature_7` (Multisensor WC)
- Luftfeuchte: `sensor.lumi_lumi_weather_humidity_7`
- Bewegungssensor (WC): `binary_sensor.lumi_lumi_sensor_motion_occupancy`

## Gästezimmer
- Licht: `light.licht_level_on_off`
- Thermostat (GZ): `climate.lumi_lumi_airrtc_agl001_thermostat`
- Temperatur: `sensor.lumi_lumi_weather_temperature_4` (Multisensor GZ)
- Luftfeuchte: `sensor.lumi_lumi_weather_humidity_4`
- Fensterkontakt (GZ): `binary_sensor.lumi_lumi_sensor_magnet_aq2_opening_7`

## Esszimmer
- LED-Stripe (EZ): `light.koogeek_ls1_209097`

## Flur
- Wandspot: `light.wandspot_light`
- Fire Tablet Bildschirm: `switch.fire_tablet_bildschirm`
- Danalock: `sensor.danalock_battery`

## Hauseingang
- Summer: `switch.sonoff_1000921029`
- Parkplatz Licht: `switch.parkplatz_light`

## Terrasse
- Terrasse Licht: `switch.terrasse_light`

## Keller
- Trockner: `switch.trockner_plug_schalter` (Strom: `sensor.trockner_plug_stromstarke`)
- Waschmaschine: `switch.waschmaschine_schalter` (Strom: `sensor.waschmaschine_stromstarke`)
- CEE Schalter: `switch.cee_schalter_schalter`

## Übergreifend
- Alle Lichter: `light.alle_lichter`
- Urlaubslichter: `light.urlaubslichter`
- Urlaub-Modus: `switch.urlaub`
