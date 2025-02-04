import {HealthStatus} from '../health_status.ts';
import {assertEquals} from 'jsr:@std/assert@1.0.7/equals';

Deno.test
(	'Basic',
	() =>
	{	const healthStatus = new HealthStatus;
		let now = Date.now();

		// do 8 yes, 2 no
		for (let i=0; i<10; i++)
		{	healthStatus.log(i<8, now);
		}

		assertEquals(healthStatus.getHealthStatusForPeriod(60, now), 8/10);

		// 1 sec elapsed
		now += 1_000;

		assertEquals(healthStatus.getHealthStatusForPeriod(60, now), 8/10);

		// do 2 yes, 8 no
		for (let i=0; i<10; i++)
		{	healthStatus.log(i>=8, now);
		}

		assertEquals(healthStatus.getHealthStatusForPeriod(1, now), 2/10);
		assertEquals(healthStatus.getHealthStatusForPeriod(2, now), 10/20);
		assertEquals(healthStatus.getHealthStatusForPeriod(60, now), 10/20);

		// 1 sec elapsed
		now += 1_000;

		assertEquals(healthStatus.getHealthStatusForPeriod(2, now), 2/10);
		assertEquals(healthStatus.getHealthStatusForPeriod(60, now), 10/20);

		// 57 sec elapsed
		now += 57_000;

		healthStatus.log(true, now);
		assertEquals(healthStatus.getHealthStatusForPeriod(60, now), 11/21);
		assertEquals(healthStatus.getHealthStatusForPeriod(59, now), 3/11);

		// 1 sec elapsed
		now += 1_000;

		assertEquals(healthStatus.getHealthStatusForPeriod(60, now), 3/11);
		assertEquals(healthStatus.getHealthStatusForPeriod(120, now), 3/11);

		// 1 sec elapsed
		now += 1_000;

		assertEquals(healthStatus.getHealthStatusForPeriod(60, now), 1/1);
	}
);
